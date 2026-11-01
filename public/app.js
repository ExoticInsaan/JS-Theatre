(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io();

  const el = {
    lobby: $('lobby'), room: $('room'),
    name: $('name'), code: $('code'), create: $('create'), join: $('join'), lobbyError: $('lobby-error'),
    roomCode: $('room-code'), nowShowing: $('now-showing'), copyLink: $('copy-link'),
    screen: $('screen'), video: $('video'), picker: $('picker'), file: $('file'),
    urlForm: $('url-form'), url: $('url'),
    banner: $('wait-banner'), resume: $('resume'), mismatch: $('mismatch'),
    status: $('status'), statusText: $('status-text'), fsStatus: $('fs-status'), fsStatusText: $('fs-status-text'),
    start: $('start'), fsToggle: $('fs-toggle'), fsBtn: $('fs-btn'), countdown: $('countdown'),
    fsFeed: $('fs-feed'), fsForm: $('fs-form'), fsInput: $('fs-input'),
    members: $('members'), messages: $('messages'), chatForm: $('chat-form'), chatInput: $('chat-input'),
  };
  const video = el.video;

  let myId = null;
  let roomCode = null;
  let members = [];
  let myFile = null;
  let lastState = null;
  let hasSource = false;
  let iAmBuffering = false;
  let objectUrl = null;
  let lastDrift = 0;
  let counting = false;
  let cdTimer = null;

  // Flags that stop a remote update from echoing back to the server as if
  // the local user had pressed the button.
  const expect = { play: false, pause: false, seeks: 0 };
  let expectTimer = null;
  function armExpect() {
    clearTimeout(expectTimer);
    expectTimer = setTimeout(() => { expect.play = expect.pause = false; expect.seeks = 0; }, 2500);
  }


  // ------------------------------------------------ status + health report
  function report() {
    socket.emit('report', {
      hasSource,
      ready: hasSource && video.readyState >= 3,
      drift: lastDrift,
    });
  }

  const STATE_TEXT = {
    nofile: 'No video yet', loading: 'Loading', buffering: 'Buffering', syncing: 'Catching up', synced: 'In sync',
  };

  function updateStatus() {
    const me = members.find((m) => m.id === myId);
    const others = members.filter((m) => m.id !== myId);
    let text, ok = false, canStart = false;

    const first = (st) => members.find((m) => m.status === st);
    if (counting) {
      text = 'Starting...';
    } else if (others.length === 0) {
      text = 'Waiting for your friend to join. Send them the invite link.';
    } else if (me && me.status === 'nofile') {
      text = 'Choose your video file to get ready.';
    } else if (first('nofile')) {
      text = `Waiting for ${first('nofile').name} to choose the video.`;
    } else if (first('loading')) {
      const l = first('loading');
      text = `${l.id === myId ? 'Your' : l.name + "'s"} video is still loading.`;
    } else if (first('buffering')) {
      text = `${first('buffering').id === myId ? 'You are' : first('buffering').name + ' is'} buffering.`;
    } else if (first('syncing')) {
      const s = first('syncing');
      text = `${s.id === myId ? 'You are' : s.name + ' is'} catching up (${Math.abs(s.drift).toFixed(1)}s off).`;
    } else {
      ok = true;
      canStart = true;
      const names = others.map((m) => m.name).join(', ');
      const notStarted = !lastState || (!lastState.intent && lastState.time < 1);
      text = notStarted ? 'Everyone is ready. Press Start together.' : `In sync with ${names}.`;
    }

    [[el.status, el.statusText], [el.fsStatus, el.fsStatusText]].forEach(([box, label]) => {
      label.textContent = text;
      box.classList.toggle('ok', ok);
      box.classList.toggle('warn', !ok);
    });
    el.start.disabled = !canStart || counting;
  }

  // ---------------------------------------------------------------- lobby
  const params = new URLSearchParams(location.search);
  if (params.get('room')) el.code.value = params.get('room').toUpperCase();
  el.name.value = localStorage.getItem('jst-name') || '';

  function lobbyError(msg) { el.lobbyError.textContent = msg || ''; }

  function enterRoom(code) {
    const name = el.name.value.trim() || 'Guest';
    localStorage.setItem('jst-name', name);
    socket.emit('join', { code, name }, (res) => {
      if (!res || res.error) return lobbyError(res ? res.error : 'Could not join.');
      myId = res.id;
      roomCode = code;
      members = res.members;
      history.replaceState(null, '', `?room=${code}`);
      el.lobby.hidden = true;
      el.room.hidden = false;
      el.roomCode.textContent = code;
      renderMembers();
      lastState = res.state;
      updateStatus();
      if (res.sharedUrl) loadUrl(res.sharedUrl);
      addSystem('You joined the room.');
    });
  }

  el.create.addEventListener('click', () => {
    lobbyError('');
    socket.emit('create', ({ code }) => enterRoom(code));
  });
  el.join.addEventListener('click', () => {
    const code = el.code.value.trim().toUpperCase();
    if (!code) return lobbyError('Enter a room code.');
    lobbyError('');
    enterRoom(code);
  });
  el.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.join.click(); });

  el.copyLink.addEventListener('click', async () => {
    const link = `${location.origin}/?room=${roomCode}`;
    try { await navigator.clipboard.writeText(link); el.copyLink.textContent = 'Link copied'; }
    catch { window.prompt('Copy this invite link:', link); }
    setTimeout(() => (el.copyLink.textContent = 'Copy invite link'), 1800);
  });

  // ---------------------------------------------------------- loading video
  function setSource(src, label) {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    if (src.startsWith('blob:')) objectUrl = src;
    video.src = src;
    hasSource = true;
    el.screen.classList.add('loaded');
    el.nowShowing.textContent = label;
    iAmBuffering = true;
    socket.emit('buffering');
    report();
  }

  function loadFile(file) {
    if (!file) return;
    if (!video.canPlayType(file.type || 'video/mp4') && !/\.(mp4|webm|m4v|mov|mkv|ogv)$/i.test(file.name)) {
      return addSystem('That file does not look like a video.');
    }
    myFile = { name: file.name, size: file.size };
    setSource(URL.createObjectURL(file), file.name);
    socket.emit('file', myFile);
    renderMembers();
  }

  function loadUrl(url) {
    myFile = null;
    setSource(url, url);
    socket.emit('file', null);
    renderMembers();
  }

  el.file.addEventListener('change', () => loadFile(el.file.files[0]));
  el.urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = el.url.value.trim();
    if (url) socket.emit('shared-url', url);
  });

  ['dragenter', 'dragover'].forEach((t) => el.screen.addEventListener(t, (e) => {
    e.preventDefault(); el.screen.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((t) => el.screen.addEventListener(t, (e) => {
    e.preventDefault(); el.screen.classList.remove('dragging');
  }));
  el.screen.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

  // Once the video is ready, catch up with whatever the room is doing.
  video.addEventListener('loadedmetadata', () => { if (lastState) applyState(lastState, true); report(); });
  video.addEventListener('error', () => {
    addSystem('This browser cannot play that file. MP4 (H.264) and WebM work best.');
    if (iAmBuffering) { iAmBuffering = false; socket.emit('ready'); }
  });

  // ------------------------------------------------- local events -> server
  video.addEventListener('play', () => {
    if (expect.play) { expect.play = false; return; }
    socket.emit('control', { action: 'play', time: video.currentTime });
  });
  video.addEventListener('pause', () => {
    if (video.ended) return;
    if (expect.pause) { expect.pause = false; return; }
    socket.emit('control', { action: 'pause', time: video.currentTime });
  });
  video.addEventListener('seeked', () => {
    if (expect.seeks > 0) { expect.seeks--; return; }
    socket.emit('control', { action: 'seek', time: video.currentTime });
  });

  // Buffering: if my player stalls, everybody holds until I'm ready.
  video.addEventListener('waiting', () => {
    if (!hasSource || iAmBuffering) return;
    iAmBuffering = true;
    socket.emit('buffering');
  });
  const markReady = () => {
    if (!iAmBuffering || video.readyState < 3) return;
    iAmBuffering = false;
    socket.emit('ready');
    report();
  };
  video.addEventListener('canplay', markReady);
  video.addEventListener('playing', markReady);

  // ------------------------------------------------ server -> local player
  function applyState(s, initial = false) {
    lastState = s;
    showWaiting(s);
    if (!hasSource || video.readyState < 1) return;

    const diff = s.time - video.currentTime;
    const limit = initial ? 0.2 : 0.35;
    if (Math.abs(diff) > limit) {
      expect.seeks++; armExpect();
      video.currentTime = s.time;
    }
    if (s.playing && video.paused) {
      expect.play = true; armExpect();
      video.play().then(() => (el.resume.hidden = true)).catch(() => {
        expect.play = false;
        el.resume.hidden = false;
      });
    } else if (!s.playing && !video.paused) {
      expect.pause = true; armExpect();
      video.pause();
    }
  }

  function showWaiting(s) {
    const others = (s.waitingFor || []).filter(Boolean);
    if (s.intent && others.length) {
      el.banner.textContent = `Waiting for ${others.join(', ')} to catch up`;
      el.banner.hidden = false;
    } else {
      el.banner.hidden = true;
    }
  }

  el.resume.addEventListener('click', () => {
    el.resume.hidden = true;
    if (lastState) applyState(lastState, true);
  });

  socket.on('state', (s) => {
    if (s.by === myId) { lastState = s; showWaiting(s); updateStatus(); return; }
    applyState(s);
    updateStatus();
  });

  // Heartbeat: gently pull drifting players back in line.
  socket.on('tick', (s) => {
    lastState = s;
    showWaiting(s);
    const diff = s.time - video.currentTime;
    lastDrift = hasSource && video.readyState >= 1 ? diff : 0;
    report();
    updateStatus();
    if (!hasSource || video.readyState < 3) return;
    if (s.playing && !video.paused) {
      if (Math.abs(diff) > 0.8) {
        expect.seeks++; armExpect();
        video.currentTime = s.time;
        video.playbackRate = 1;
      } else if (diff > 0.12) video.playbackRate = 1.05;
      else if (diff < -0.12) video.playbackRate = 0.95;
      else video.playbackRate = 1;
    } else {
      video.playbackRate = 1;
      if (!s.playing && Math.abs(diff) > 0.4) {
        expect.seeks++; armExpect();
        video.currentTime = s.time;
      }
    }
  });

  socket.on('shared-url', ({ url, by }) => {
    if (url) { addSystem(`${by || 'Someone'} shared a video link.`); loadUrl(url); }
  });

  // ---------------------------------------------------------------- people
  socket.on('members', (list) => { members = list; renderMembers(); updateStatus(); });

  function fmtSize(b) {
    if (!b) return '';
    const gb = b / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`;
  }

  function renderMembers() {
    el.members.innerHTML = '';
    members.forEach((m) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot ' + (m.status || 'nofile');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = m.name + (m.id === myId ? ' (you)' : '');
      const file = document.createElement('span');
      file.className = 'file';
      file.textContent = m.file ? `${m.file.name} ${fmtSize(m.file.size)}`.trim() : (m.status === 'nofile' ? '' : 'Shared link');
      const state = document.createElement('span');
      state.className = 'state ' + (m.status || 'nofile');
      state.textContent = STATE_TEXT[m.status] || '';
      li.append(dot, who, state, file);
      el.members.append(li);
    });

    // Warn when two people loaded different files (timestamps would not line up).
    const mine = members.find((m) => m.id === myId);
    const differing = members.filter((m) =>
      m.id !== myId && m.file && mine && mine.file && m.file.size !== mine.file.size);
    if (differing.length) {
      el.mismatch.textContent =
        `${differing.map((m) => m.name).join(', ')} loaded a file with a different size. ` +
        'Sync only works well when everyone has the exact same file.';
      el.mismatch.hidden = false;
    } else {
      el.mismatch.hidden = true;
    }
  }


  // ------------------------------------------------------ start together
  el.start.addEventListener('click', () => socket.emit('start'));

  socket.on('countdown', ({ seconds, by }) => {
    clearInterval(cdTimer);
    let n = seconds;
    counting = true;
    el.countdown.hidden = false;
    el.countdown.textContent = n;
    updateStatus();
    addSystem(`${by} started the countdown.`);
    cdTimer = setInterval(() => {
      n--;
      if (n > 0) { el.countdown.textContent = n; return; }
      clearInterval(cdTimer);
      el.countdown.textContent = 'Go';
      setTimeout(() => { el.countdown.hidden = true; counting = false; updateStatus(); }, 800);
    }, 1000);
  });

  // ------------------------------------------------------------ fullscreen
  function toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    const target = el.screen;
    if (target.requestFullscreen) target.requestFullscreen().catch(() => {});
    else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone: video only
  }
  el.fsToggle.addEventListener('click', toggleFullscreen);
  el.fsBtn.addEventListener('click', toggleFullscreen);

  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    el.fsBtn.textContent = fs ? 'Exit fullscreen' : 'Fullscreen';
    if (!fs) { el.fsForm.hidden = true; el.fsFeed.innerHTML = ''; }
  });

  // Show the fullscreen button / status briefly when the mouse moves.
  let activeTimer;
  el.screen.addEventListener('mousemove', () => {
    el.screen.classList.add('active');
    clearTimeout(activeTimer);
    activeTimer = setTimeout(() => el.screen.classList.remove('active'), 2500);
  });

  // Fullscreen chat: new messages float over the video; Enter opens a box.
  function floatMessage(name, text, system) {
    if (!document.fullscreenElement) return;
    const li = document.createElement('li');
    if (!system) {
      const n = document.createElement('span');
      n.className = 'name';
      n.textContent = name;
      li.append(n);
    }
    li.append(document.createTextNode(text));
    el.fsFeed.append(li);
    while (el.fsFeed.children.length > 5) el.fsFeed.firstChild.remove();
    setTimeout(() => li.remove(), 9000);
  }

  document.addEventListener('keydown', (e) => {
    if (el.room.hidden) return;
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape' && document.activeElement === el.fsInput) {
      el.fsForm.hidden = true; el.fsInput.blur(); return;
    }
    if (typing) return;
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
    if (e.key === 'Enter' && document.fullscreenElement) {
      e.preventDefault();
      el.fsForm.hidden = false;
      el.fsInput.focus();
    }
  });
  el.fsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.fsInput.value.trim();
    if (text) socket.emit('chat', text);
    el.fsInput.value = '';
    el.fsForm.hidden = true;
    el.fsInput.blur();
  });

  // ------------------------------------------------------------------ chat
  function addMessage(node) {
    const stick = el.messages.scrollTop + el.messages.clientHeight >= el.messages.scrollHeight - 30;
    el.messages.append(node);
    if (stick) el.messages.scrollTop = el.messages.scrollHeight;
  }
  function addSystem(text) {
    const li = document.createElement('li');
    li.className = 'system';
    li.textContent = text;
    addMessage(li);
    floatMessage('', text, true);
  }
  socket.on('system', addSystem);
  socket.on('chat', ({ id, name, text }) => {
    const li = document.createElement('li');
    if (id === myId) li.className = 'me';
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    li.append(n, document.createTextNode(text));
    addMessage(li);
    floatMessage(name, text, false);
  });
  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    socket.emit('chat', text);
    el.chatInput.value = '';
  });

  // Reconnect: rejoin the same room automatically.
  socket.on('connect', () => {
    if (roomCode && myId && socket.id !== myId) enterRoom(roomCode);
  });
})();
