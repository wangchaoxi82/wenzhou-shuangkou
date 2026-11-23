// 温州双扣客户端（vanilla JS，逻辑复用 public/shared.js）
(function () {
  'use strict';
  var SK = window.ShuangKou;

  var ws = null;
  var myName = '';
  var myCode = '';
  var state = null; // 最新服务器状态
  var selected = new Set();
  var passedSeats = new Set(); // 本轮已过牌的座位（客户端推断）
  var prevPlayKey = '';
  var prevTurn = -1;
  var intentionalClose = false;
  var reconnectTimer = null;

  // 聊天
  var chatOpen = false;
  var unreadChat = 0;

  // 语音：voiceMode: off | on | muted（自己静音，不断连接）
  var voice = null;
  var voiceMode = 'off';
  var remoteMuted = new Set(); // 不想听的座位
  var audioEls = {}; // seat -> <audio>
  var voiceStates = {}; // seat -> 'connecting' | 'connected' | 'disconnected' | 'failed'

  // 手机浏览器常拦截非手势触发的音频播放：任何一次点击/触摸都尝试把已有的远端音频播起来
  function unlockAudio() {
    Object.keys(audioEls).forEach(function (seat) {
      var audio = audioEls[seat];
      if (audio && audio.paused && audio.srcObject) {
        var p = audio.play();
        if (p && p.catch) p.catch(function () {});
      }
    });
  }
  document.addEventListener('pointerdown', unlockAudio);
  document.addEventListener('touchstart', unlockAudio);

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var landingEl = $('landing'), lobbyEl = $('lobby'), tableEl = $('table');

  function show(el) { [landingEl, lobbyEl, tableEl].forEach(function (s) { s.classList.toggle('hidden', s !== el); }); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2500);
  }

  // ---------- WebSocket ----------
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host);
    ws.onopen = function () {
      $('connState').classList.add('hidden');
      // 断线重连：自动用存下的名字和房间代码重新加入
      var saved = null;
      try { saved = JSON.parse(sessionStorage.getItem('sk-session') || 'null'); } catch (e) {}
      if (saved && saved.name && saved.code) {
        myName = saved.name; myCode = saved.code;
        send({ t: 'join', code: saved.code, name: saved.name });
      }
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'state') onState(msg);
      else if (msg.t === 'error') { toast(msg.msg); $('landingErr').textContent = msg.msg; }
      else if (msg.t === 'chat') onChatMsg(msg);
      else if (msg.t === 'voice-state') onVoiceState(msg);
      else if (msg.t === 'rtc-offer' && voice) voice.handleOffer(msg.from, msg.sdp).catch(function () {});
      else if (msg.t === 'rtc-answer' && voice) voice.handleAnswer(msg.from, msg.sdp).catch(function () {});
      else if (msg.t === 'rtc-ice' && voice) voice.handleIce(msg.from, msg.candidate).catch(function () {});
    };
    ws.onclose = function () {
      if (intentionalClose) return;
      $('connState').classList.remove('hidden');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function saveSession() {
    try { sessionStorage.setItem('sk-session', JSON.stringify({ name: myName, code: myCode })); } catch (e) {}
  }

  // ---------- 聊天 ----------
  function fmtTime(ts) {
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function onChatMsg(m) {
    var box = $('chatMessages');
    var empty = box.querySelector('.chat-empty');
    if (empty) empty.remove();
    var d = document.createElement('div');
    d.className = 'chat-msg' + (state && m.seat === state.mySeat ? ' me' : '');
    d.innerHTML = '<span class="who">' + esc(m.name) + '</span><span class="tm">' + fmtTime(m.time) + '</span><br>' + esc(m.text);
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
    if (!chatOpen) {
      unreadChat++;
      updateChatBadge();
    }
  }

  function updateChatBadge() {
    ['chatBadge1', 'chatBadge2'].forEach(function (id) {
      var b = $(id);
      b.textContent = unreadChat > 99 ? '99+' : String(unreadChat);
      b.classList.toggle('hidden', unreadChat === 0);
    });
  }

  function setChatOpen(open) {
    chatOpen = open;
    $('chatPanel').classList.toggle('hidden', !open);
    if (open) {
      unreadChat = 0;
      updateChatBadge();
      var box = $('chatMessages');
      box.scrollTop = box.scrollHeight;
    }
  }

  function sendChat(text) {
    text = (text || '').trim();
    if (!text) return;
    send({ t: 'chat', text: text });
  }

  // ---------- 语音 ----------
  function ensureVoice() {
    if (voice) return voice;
    voice = new window.VoiceChat({
      mySeat: state ? state.mySeat : 0,
      send: send,
      onTrack: function (seat, stream) {
        var audio = audioEls[seat];
        if (!audio) {
          audio = document.createElement('audio');
          audio.autoplay = true;
          audio.playsInline = true;
          audio.setAttribute('playsinline', '');
          audioEls[seat] = audio;
          $('audioBox').appendChild(audio);
        }
        audio.srcObject = stream;
        audio.muted = remoteMuted.has(seat);
        unlockAudio();
      },
      onConnectionState: function (seat, st) {
        voiceStates[seat] = st;
        if (st === 'failed' && state && state.seats[seat]) {
          toast('与' + state.seats[seat].name + '的语音没连上，可能是网络问题');
        }
        if (!state) return;
        if (state.phase === 'playing') renderTable(state);
        else if (state.phase === 'lobby') renderLobby(state);
      },
      onPeerClosed: function (seat) {
        var audio = audioEls[seat];
        if (audio) { audio.srcObject = null; audio.remove(); delete audioEls[seat]; }
        delete voiceStates[seat];
      },
    });
    return voice;
  }

  function updateVoiceButtons() {
    var label = voiceMode === 'off' ? '🎤 语音：关' : voiceMode === 'on' ? '🎤 语音：开' : '🎤 语音：静音';
    var short = voiceMode === 'off' ? '🎤 关' : voiceMode === 'on' ? '🎤 开' : '🎤 静音';
    $('voiceBtn1').textContent = label;
    $('voiceBtn2').textContent = short;
    $('voiceBtn1').classList.toggle('on', voiceMode === 'on');
    $('voiceBtn1').classList.toggle('muted', voiceMode === 'muted');
    $('voiceBtn2').classList.toggle('on', voiceMode === 'on');
    $('voiceBtn2').classList.toggle('muted', voiceMode === 'muted');
    $('voiceOffBtn').classList.toggle('hidden', voiceMode === 'off');
  }

  // 语音开关：关 → 开（请求麦克风）→ 点一下静音 → 再点取消静音；✕ 按钮彻底关闭
  function toggleVoice() {
    if (voiceMode === 'off') {
      if (!window.VoiceChat || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        toast('当前浏览器不支持语音');
        return;
      }
      var v = ensureVoice();
      v.mySeat = state.mySeat;
      v.start().then(function () {
        voiceMode = 'on';
        updateVoiceButtons();
        unlockAudio(); // 手势上下文里把已有远端音频播起来（手机自动播放限制）
        send({ t: 'voice', on: true });
        // 向已开语音且座位号比我大的玩家发起连接（小号发起，避免冲突）
        state.seats.forEach(function (p, i) {
          if (p.voice && i !== state.mySeat && state.mySeat < i) {
            voiceStates[i] = 'connecting';
            v.createOffer(i).catch(function () {});
          }
        });
        toast('语音已开启');
      }).catch(function () {
        toast('麦克风权限被拒绝，语音未开启');
      });
    } else if (voiceMode === 'on') {
      voice.setMuted(true);
      voiceMode = 'muted';
      updateVoiceButtons();
    } else {
      voice.setMuted(false);
      voiceMode = 'on';
      updateVoiceButtons();
    }
  }

  function turnVoiceOff() {
    if (voice) voice.stop();
    voiceMode = 'off';
    voiceStates = {};
    updateVoiceButtons();
    send({ t: 'voice', on: false });
  }

  function onVoiceState(msg) {
    if (!state) return;
    // 更新本地状态里的语音标记（完整 state 随后也会到）
    if (state.seats[msg.seat]) state.seats[msg.seat].voice = msg.on;
    if (msg.seat === state.mySeat) return;
    if (!msg.on) {
      if (voice) voice.closePeer(msg.seat);
      return;
    }
    // 对方开了语音：我是小号且我也开着 → 我发起
    if (voiceMode !== 'off' && voice && state.mySeat < msg.seat) {
      voiceStates[msg.seat] = 'connecting';
      voice.createOffer(msg.seat).catch(function () {});
    }
    if (state.phase === 'playing') renderTable(state);
    else if (state.phase === 'lobby') renderLobby(state);
  }

  // 语音连接状态点：🟡连接中 🟢已连接 🔴失败（自己或对方没开语音时不显示）
  function voiceDot(seat) {
    if (voiceMode === 'off' || seat === state.mySeat) return '';
    var st = voiceStates[seat];
    if (!st) return '';
    if (st === 'connected') return ' <span class="vdot ok" title="语音已连接">🟢</span>';
    if (st === 'failed') return ' <span class="vdot bad" title="语音没连上">🔴</span>';
    return ' <span class="vdot" title="语音连接中">🟡</span>';
  }

  // ---------- 状态渲染 ----------
  function onState(s) {
    // 推断过牌：回合推进且当前牌没变 → 上一位过牌；当前牌变化/新局 → 清空
    var playKey = s.currentPlay ? s.currentPlay.seat + ':' + s.currentPlay.cards.slice().sort().join(',') : '';
    if (s.handNo !== (state && state.handNo) || playKey !== prevPlayKey) {
      passedSeats.clear();
      if (playKey) passedSeats.delete(s.currentPlay.seat);
    } else if (prevTurn !== -1 && s.turn !== prevTurn && s.currentPlay) {
      passedSeats.add(prevTurn);
    }
    if (!s.currentPlay) passedSeats.clear();
    prevPlayKey = playKey;
    prevTurn = s.turn;
    state = s;
    myCode = s.code;
    if (voice) voice.mySeat = s.mySeat;
    saveSession();

    if (s.phase === 'lobby') { show(lobbyEl); renderLobby(s); }
    else { show(tableEl); renderTable(s); }

    if (s.phase === 'handOver' && s.handResult) showResult(s);
    else $('resultModal').classList.add('hidden');
  }

  function seatPosLabel(i) { return ['东', '南', '西', '北'][i] + '家'; }

  function renderLobby(s) {
    $('roomCode').textContent = s.code;
    var seatsEl = $('seats');
    seatsEl.innerHTML = '';
    s.seats.forEach(function (p, i) {
      var d = document.createElement('div');
      d.className = 'seat' + (i === s.mySeat ? ' me' : '') + (p.name ? '' : ' empty');
      var btn = '';
      if (!p.name && s.mySeat !== -1) btn = '<button class="btn small" data-seat="' + i + '">坐这儿</button>';
      d.innerHTML = '<div class="pos">' + seatPosLabel(i) + '</div>' +
        '<div class="name">' + (p.name ? esc(p.name) : '空座位') + (p.voice ? ' <span class="voice-ico">🎤</span>' + voiceDot(i) : '') + '</div>' +
        '<div class="st' + (p.ready ? ' ready' : '') + '">' + (p.name ? (p.ready ? '✓ 已准备' : (p.connected ? '未准备' : '断线中…')) : '') + '</div>' + btn;
      seatsEl.appendChild(d);
    });
    seatsEl.querySelectorAll('[data-seat]').forEach(function (b) {
      b.onclick = function () { send({ t: 'seat', seat: parseInt(b.getAttribute('data-seat'), 10) }); };
    });
    var me = s.seats[s.mySeat];
    var readyBtn = $('readyBtn');
    readyBtn.textContent = me && me.ready ? '取消准备' : '准备';
    readyBtn.classList.toggle('primary', !(me && me.ready));
    var n = s.seats.filter(function (p) { return p.name; }).length;
    $('lobbyHint').textContent = s.startingIn > 0 ? '即将开始…' :
      (n < 4 ? '已有 ' + n + ' 人，再来 ' + (4 - n) + ' 人' : '等所有人点准备');
  }

  // 相对位置：0 自己（下），1 右，2 对家（上），3 左
  function relSeat(s, rel) { return (s.mySeat + rel) % 4; }

  function cardEl(id, small) {
    var c = SK.cardOf(id);
    var d = document.createElement('div');
    d.className = 'card' + (small ? ' small' : '') + (SK.isRed(c) ? ' red' : '') + ((c.rank === 16 || c.rank === 17) ? ' joker' : '');
    if (c.rank === 16) d.innerHTML = '<div class="r">小王</div>';
    else if (c.rank === 17) d.innerHTML = '<div class="r">大王</div>';
    else d.innerHTML = '<div class="r">' + SK.rankName(c.rank) + '</div><div class="s">' + SK.SUITS[c.suit] + '</div>';
    return d;
  }

  function renderOpp(el, s, seat, tag) {
    var p = s.seats[seat];
    el.classList.toggle('turn', s.turn === seat && s.phase === 'playing');
    el.classList.toggle('out', !!p.out);
    var timer = '';
    if (s.turn === seat && s.phase === 'playing') timer = ' <span class="timer" data-seat="' + seat + '"></span>';
    // 语音标记 + 不听此人按钮（仅双方都开语音时有效）
    var voiceHtml = '';
    if (p.voice) {
      voiceHtml = ' <span class="voice-ico">🎤</span>' + voiceDot(seat);
      if (voiceMode !== 'off') {
        var muted = remoteMuted.has(seat);
        voiceHtml += '<button class="mute-btn' + (muted ? ' off' : '') + '" data-mute="' + seat + '">' + (muted ? '🔇' : '🔊') + '</button>';
      }
    }
    var played = '';
    if (s.currentPlay && s.currentPlay.seat === seat) {
      played = '<div class="played">' + s.currentPlay.cards.map(function (id) {
        var c = SK.cardOf(id);
        var cls = 'card small' + (SK.isRed(c) ? ' red' : '') + ((c.rank >= 16) ? ' joker' : '');
        var inner = c.rank === 16 ? '<div class="r">小王</div>' : c.rank === 17 ? '<div class="r">大王</div>' :
          '<div class="r">' + SK.rankName(c.rank) + '</div><div class="s">' + SK.SUITS[c.suit] + '</div>';
        return '<div class="' + cls + '">' + inner + '</div>';
      }).join('') + '</div>';
    } else if (passedSeats.has(seat)) {
      played = '<div class="pass">不要</div>';
    }
    el.innerHTML = '<div class="nm">' + esc(p.name || '—') + tag + voiceHtml + timer + '</div>' +
      '<div class="meta">' + (p.out ? '第 ' + p.place + ' 名 · 已出完' : '剩 ' + p.cards + ' 张') + ' · ' + (p.score >= 0 ? '+' : '') + p.score + ' 分' + (p.connected ? '' : ' · 断线') + '</div>' +
      played;
    el.querySelectorAll('[data-mute]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var st = parseInt(b.getAttribute('data-mute'), 10);
        if (remoteMuted.has(st)) remoteMuted.delete(st);
        else remoteMuted.add(st);
        var audio = audioEls[st];
        if (audio) audio.muted = remoteMuted.has(st);
        renderTable(state);
      };
    });
  }

  function renderTable(s) {
    $('roomCode2').textContent = s.code;
    $('handNo').textContent = s.handNo;
    var me = s.mySeat;
    renderOpp($('oppTop'), s, relSeat(s, 2), '<span class="tag">队友</span>');
    renderOpp($('oppLeft'), s, relSeat(s, 3), '<span class="tag foe">对手</span>');
    renderOpp($('oppRight'), s, relSeat(s, 1), '<span class="tag foe">对手</span>');

    // 中央：当前牌
    var lp = $('lastPlay');
    if (s.currentPlay) {
      var who = s.currentPlay.seat === me ? '你' : s.seats[s.currentPlay.seat].name;
      lp.innerHTML = '<div class="desc">' + esc(who) + '：' + esc(s.currentPlay.desc) + '</div>' +
        s.currentPlay.cards.map(function (id) {
          var c = SK.cardOf(id);
          var cls = 'card small' + (SK.isRed(c) ? ' red' : '') + ((c.rank >= 16) ? ' joker' : '');
          var inner = c.rank === 16 ? '<div class="r">小王</div>' : c.rank === 17 ? '<div class="r">大王</div>' :
            '<div class="r">' + SK.rankName(c.rank) + '</div><div class="s">' + SK.SUITS[c.suit] + '</div>';
          return '<div class="' + cls + '">' + inner + '</div>';
        }).join('');
    } else {
      lp.innerHTML = '<div class="desc">' + (s.phase === 'playing' ? '新一轮，轮到出牌' : '') + '</div>';
    }
    $('centerHint').textContent = '';

    // 记分条
    $('scoreBar').innerHTML = s.seats.map(function (p, i) {
      return '<span class="' + (i === me ? 'me' : '') + '">' + esc(p.name || '—') + ' ' + (p.score >= 0 ? '+' : '') + p.score + '</span>';
    }).join('');

    // 自己信息 + 倒计时
    var myInfo = $('myInfo');
    var p = s.seats[me];
    if (s.phase !== 'playing') {
      myInfo.innerHTML = '';
    } else if (p.out) {
      myInfo.innerHTML = '你已出完，第 ' + p.place + ' 名，观战中';
    } else if (s.turn === me) {
      myInfo.innerHTML = '<span class="turn-me">轮到你出牌 <span class="timer" data-seat="' + me + '"></span></span>';
    } else {
      myInfo.innerHTML = '等待 ' + esc(s.seats[s.turn].name) + ' 出牌…';
    }

    // 手牌（扇形排列：按行分组，每行中间高两边低、略带旋转）
    // 先去掉已不在手里的选中牌（比如超时被系统自动出了）
    selected = new Set(Array.from(selected).filter(function (id) { return s.hand.indexOf(id) !== -1; }));
    var handEl = $('myHand');
    handEl.innerHTML = '';
    s.hand.forEach(function (id) {
      var el = cardEl(id, false);
      el.setAttribute('data-card', String(id));
      if (selected.has(id)) el.classList.add('selected');
      el.onclick = function () {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        el.classList.toggle('selected');
        layoutHand();
        updatePlayHint();
      };
      handEl.appendChild(el);
    });
    layoutHand();

    // 按钮状态
    var myTurn = s.phase === 'playing' && s.turn === me && !p.out;
    $('playBtn').disabled = !myTurn;
    $('passBtn').disabled = !myTurn || !s.currentPlay;
    $('hintBtn').disabled = !myTurn;
    updatePlayHint();
  }

  // 手牌扇形布局：按实际行分组，每行中间高、两边低且略旋转；选中的牌上浮
  function layoutHand() {
    var handEl = $('myHand');
    var cards = Array.prototype.slice.call(handEl.children);
    if (!cards.length) return;
    var rows = {};
    cards.forEach(function (el) {
      var top = el.offsetTop;
      (rows[top] = rows[top] || []).push(el);
    });
    Object.keys(rows).forEach(function (top) {
      var row = rows[top];
      var mid = (row.length - 1) / 2;
      row.forEach(function (el, i) {
        var d = i - mid;
        var rot = d * 1.1;
        var y = Math.abs(d) * 0.8;
        var id = parseInt(el.getAttribute('data-card'), 10);
        if (selected.has(id)) y -= 18;
        el.style.transform = 'rotate(' + rot.toFixed(1) + 'deg) translateY(' + y.toFixed(1) + 'px)';
        el.style.zIndex = selected.has(id) ? 20 : i + 1;
      });
    });
  }

  function updatePlayHint() {
    var hintEl = $('playHint');
    if (!state || state.phase !== 'playing' || selected.size === 0) { hintEl.textContent = ''; return; }
    var ids = Array.from(selected);
    var combo = SK.detect(ids);
    if (!combo) { hintEl.textContent = '不是合法牌型'; return; }
    if (state.currentPlay) {
      var cur = SK.detect(state.currentPlay.cards);
      if (!SK.beats(combo, cur)) { hintEl.textContent = combo.desc + '（压不过上家）'; return; }
    }
    hintEl.textContent = combo.desc;
  }

  function showResult(s) {
    var r = s.handResult;
    var names = { shuang: '双扣', dan: '单扣', ping: '平扣' };
    var winTeam = r.first % 2 === s.mySeat % 2;
    $('resultTitle').textContent = names[r.type] + ' · ' + (winTeam ? '你们赢了！' : '对方赢了');
    var rows = s.seats.map(function (p, i) {
      var place = r.places[i] ? '第 ' + r.places[i] + ' 名' : '未出完';
      var d = r.delta[i];
      return '<tr><td>' + esc(p.name) + (i === s.mySeat ? '（你）' : '') + '</td><td>' + place + '</td>' +
        '<td class="' + (d > 0 ? 'win' : 'lose') + '">' + (d > 0 ? '+' : '') + d + '</td>' +
        '<td>' + (r.scores[i] >= 0 ? '+' : '') + r.scores[i] + '</td></tr>';
    }).join('');
    $('resultBody').innerHTML = '<table><tr><th>玩家</th><th>名次</th><th>本局</th><th>总分</th></tr>' + rows + '</table>';
    var voted = s.again.indexOf(s.mySeat) !== -1;
    $('againBtn').disabled = voted;
    $('againBtn').textContent = voted ? '已确认，等待其他人…' : '再来一局';
    $('againHint').textContent = s.again.length + ' / 4 人已确认';
    $('resultModal').classList.remove('hidden');
  }

  function esc(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 倒计时 ----------
  setInterval(function () {
    if (!state || state.phase !== 'playing' || !state.turnDeadline) return;
    var left = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
    document.querySelectorAll('.timer').forEach(function (el) {
      el.textContent = left + 's';
      el.classList.toggle('low', left <= 10);
    });
  }, 250);

  // ---------- 事件 ----------
  function checkName() {
    var name = $('nameInput').value.trim();
    if ([...name].length < 2 || [...name].length > 8) {
      $('landingErr').textContent = '昵称 2–8 个字，必填';
      return null;
    }
    $('landingErr').textContent = '';
    return name;
  }
  $('createBtn').onclick = function () {
    var name = checkName();
    if (!name) return;
    myName = name;
    send({ t: 'create', name: name });
  };
  $('joinBtn').onclick = function () {
    var name = checkName();
    if (!name) return;
    var code = $('codeInput').value.trim().toUpperCase();
    if (!code) { $('landingErr').textContent = '先填房间代码'; return; }
    myName = name; myCode = code;
    send({ t: 'join', code: code, name: name });
  };
  $('readyBtn').onclick = function () { send({ t: 'ready' }); };
  $('leaveBtn1').onclick = leaveRoom;
  $('copyLinkBtn').onclick = function () {
    var link = location.origin + location.pathname + '?room=' + state.code;
    function done() { toast('邀请链接已复制'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () { fallbackCopy(link); done(); });
    } else { fallbackCopy(link); done(); }
  };
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }
  function leaveRoom() {
    if (voiceMode !== 'off') turnVoiceOff();
    intentionalClose = true;
    send({ t: 'leave' });
    try { sessionStorage.removeItem('sk-session'); } catch (e) {}
    setTimeout(function () { location.href = location.pathname; }, 200);
  }

  // 聊天
  $('chatToggleBtn1').onclick = function () { setChatOpen(!chatOpen); };
  $('chatToggleBtn2').onclick = function () { setChatOpen(!chatOpen); };
  $('chatCloseBtn').onclick = function () { setChatOpen(false); };
  $('chatSendBtn').onclick = function () {
    sendChat($('chatInput').value);
    $('chatInput').value = '';
    $('chatInput').focus();
  };
  $('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      sendChat($('chatInput').value);
      $('chatInput').value = '';
    }
  });
  document.querySelectorAll('#quickPhrases [data-phrase]').forEach(function (b) {
    b.onclick = function () { sendChat(b.getAttribute('data-phrase')); };
  });

  // 语音
  $('voiceBtn1').onclick = toggleVoice;
  $('voiceBtn2').onclick = toggleVoice;
  $('voiceOffBtn').onclick = turnVoiceOff;

  $('playBtn').onclick = function () {
    if (!state || selected.size === 0) { toast('先选牌'); return; }
    var ids = Array.from(selected);
    var combo = SK.detect(ids);
    if (!combo) { toast('不是合法牌型'); return; }
    if (state.currentPlay) {
      var cur = SK.detect(state.currentPlay.cards);
      if (!SK.beats(combo, cur)) { toast('压不过上家（' + cur.desc + '）'); return; }
    }
    send({ t: 'play', cards: ids });
    selected.clear();
  };
  $('passBtn').onclick = function () { send({ t: 'pass' }); selected.clear(); };
  $('hintBtn').onclick = function () {
    if (!state) return;
    var cur = state.currentPlay ? SK.detect(state.currentPlay.cards) : null;
    var hint = SK.hintPlay(state.hand, cur);
    if (!hint) { toast(state.currentPlay ? '没有能压过的牌，点“不要”' : '没有可出的牌'); return; }
    selected = new Set(hint.cards);
    renderTable(state);
  };
  $('againBtn').onclick = function () { send({ t: 'again' }); };

  // 规则弹窗
  function openRules() { $('rulesModal').classList.remove('hidden'); }
  function closeRules() { $('rulesModal').classList.add('hidden'); }
  $('rulesBtn1').onclick = openRules;
  $('rulesBtn2').onclick = openRules;
  $('rulesBtn3').onclick = openRules;
  $('closeRulesBtn').onclick = closeRules;
  $('rulesModal').onclick = function (e) { if (e.target === $('rulesModal')) closeRules(); };

  // 链接带房间代码时预填
  (function () {
    var m = /[?&]room=([A-Za-z0-9]{4})/.exec(location.search);
    if (m) $('codeInput').value = m[1].toUpperCase();
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('sk-session') || 'null'); } catch (e) {}
    if (saved && saved.name) $('nameInput').value = saved.name;
  })();

  connect();
})();
