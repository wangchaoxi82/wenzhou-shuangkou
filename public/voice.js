// 房间语音：WebRTC 点对点 mesh（每人连另外 3 人），信令走已有 WebSocket。
// UMD：浏览器里用 window.VoiceChat，Node 测试里 require。
// 依赖可注入，便于用 mock 测试：createPC、getUserMedia。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceChat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  // opts: { mySeat, send(msg), onTrack(seat, stream), onPeerClosed(seat),
  //         createPC(config), getUserMedia(constraints), iceServers? }
  function VoiceChat(opts) {
    this.mySeat = opts.mySeat;
    this.send = opts.send;
    this.onTrack = opts.onTrack || function () {};
    this.onPeerClosed = opts.onPeerClosed || function () {};
    this.createPC = opts.createPC || function (config) { return new RTCPeerConnection(config); };
    this.getUserMedia = opts.getUserMedia || function (c) {
      return navigator.mediaDevices.getUserMedia(c);
    };
    this.iceServers = opts.iceServers || DEFAULT_ICE;
    this.localStream = null;
    this.muted = false;
    this.started = false;
    this.peers = new Map(); // seat -> RTCPeerConnection
  }

  VoiceChat.DEFAULT_ICE = DEFAULT_ICE;

  // 开启语音：请求麦克风（需用户手势调用），拿到本地流
  VoiceChat.prototype.start = function () {
    var self = this;
    if (this.started) return Promise.resolve(this.localStream);
    return this.getUserMedia({ audio: true, video: false }).then(function (stream) {
      self.localStream = stream;
      self.started = true;
      self.muted = false;
      self.peers.forEach(function (pc) { self._addTracks(pc); });
      return stream;
    });
  };

  // 完全关闭语音：关掉所有连接并停掉麦克风
  VoiceChat.prototype.stop = function () {
    this.closeAll();
    if (this.localStream) {
      this.localStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      this.localStream = null;
    }
    this.started = false;
    this.muted = false;
  };

  // 静音/取消静音自己（不断连接）
  VoiceChat.prototype.setMuted = function (m) {
    this.muted = !!m;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(function (t) { t.enabled = !m; });
    }
    return this.muted;
  };

  VoiceChat.prototype._addTracks = function (pc) {
    if (!this.localStream) return;
    var self = this;
    var senders = typeof pc.getSenders === 'function' ? pc.getSenders() : [];
    this.localStream.getAudioTracks().forEach(function (track) {
      var exists = senders.some(function (s) { return s.track === track; });
      if (!exists) pc.addTrack(track, self.localStream);
    });
  };

  VoiceChat.prototype.ensurePeer = function (seat) {
    if (this.peers.has(seat)) return this.peers.get(seat);
    var self = this;
    var pc = this.createPC({ iceServers: this.iceServers });
    pc.onicecandidate = function (e) {
      self.send({ t: 'rtc-ice', to: seat, candidate: (e.candidate ? e.candidate : null) });
    };
    pc.ontrack = function (e) {
      var stream = (e.streams && e.streams[0]) || null;
      if (stream) self.onTrack(seat, stream);
    };
    this._addTracks(pc);
    this.peers.set(seat, pc);
    return pc;
  };

  // 向某座位发起连接（约定：座位号小的那方发起，避免双方同时发起）
  VoiceChat.prototype.createOffer = function (seat) {
    var self = this;
    var pc = this.ensurePeer(seat);
    return pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer).then(function () {
        self.send({ t: 'rtc-offer', to: seat, sdp: pc.localDescription });
      });
    });
  };

  VoiceChat.prototype.handleOffer = function (from, sdp) {
    var self = this;
    var pc = this.ensurePeer(from);
    var proceed = function () {
      return pc.setRemoteDescription(sdp).then(function () {
        return pc.createAnswer();
      }).then(function (answer) {
        return pc.setLocalDescription(answer).then(function () {
          self.send({ t: 'rtc-answer', to: from, sdp: pc.localDescription });
        });
      });
    };
    // 双方同时发起（glare）：座位号小的优先，大的回滚自己的 offer 接受对方的
    if (pc.signalingState !== 'stable') {
      if (from < this.mySeat) {
        return pc.setLocalDescription({ type: 'rollback' }).then(proceed);
      }
      return Promise.resolve(); // 忽略，保留自己的 offer
    }
    return proceed();
  };

  VoiceChat.prototype.handleAnswer = function (from, sdp) {
    var pc = this.peers.get(from);
    if (!pc) return Promise.resolve();
    if (pc.signalingState !== 'have-local-offer') return Promise.resolve(); // 过期的 answer
    return pc.setRemoteDescription(sdp);
  };

  VoiceChat.prototype.handleIce = function (from, candidate) {
    var pc = this.peers.get(from);
    if (!pc || !candidate) return Promise.resolve();
    return pc.addIceCandidate(candidate).catch(function () { /* 忽略无效 candidate */ });
  };

  VoiceChat.prototype.closePeer = function (seat) {
    var pc = this.peers.get(seat);
    if (!pc) return;
    try { pc.close(); } catch (e) {}
    this.peers.delete(seat);
    this.onPeerClosed(seat);
  };

  VoiceChat.prototype.closeAll = function () {
    var self = this;
    Array.from(this.peers.keys()).forEach(function (seat) { self.closePeer(seat); });
  };

  return VoiceChat;
});
