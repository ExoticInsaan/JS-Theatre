const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Room state lives in memory. Each room tracks the shared playback intent
// (playing / time) plus who is currently buffering, so everyone can wait.
// ---------------------------------------------------------------------------
const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      playing: false,
      time: 0,
      updatedAt: Date.now(),
      waiting: new Set(),
      members: new Map(), // socket.id -> { name, file }
      sharedUrl: null,
    });
  }
  return rooms.get(code);
}

function effectivelyPlaying(room) {
  return room.playing && room.waiting.size === 0;
}

function position(room) {
  if (!effectivelyPlaying(room)) return room.time;
  return room.time + (Date.now() - room.updatedAt) / 1000;
}

// Lock in the current position before changing anything that affects it.
function freeze(room) {
  room.time = position(room);
  room.updatedAt = Date.now();
}

function snapshot(room) {
  return {
    playing: effectivelyPlaying(room),
    intent: room.playing,
    time: position(room),
    waitingFor: [...room.waiting].map((id) => room.members.get(id)?.name).filter(Boolean),
  };
}

function memberList(room) {
  return [...room.members.entries()].map(([id, m]) => ({ id, name: m.name, file: m.file }));
}

function broadcastState(room, by) {
  io.to(room.code).emit('state', { ...snapshot(room), by });
}

io.on('connection', (socket) => {
  let current = null;

  socket.on('create', (cb) => cb && cb({ code: makeCode() }));

  socket.on('join', ({ code, name }, cb) => {
    code = String(code || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{3,8}$/.test(code)) return cb && cb({ error: 'Invalid room code.' });
    const room = getRoom(code);
    if (room.members.size >= 8) return cb && cb({ error: 'This room is full.' });

    current = room;
    socket.join(code);
    room.members.set(socket.id, {
      name: String(name || 'Guest').slice(0, 24),
      file: null,
    });

    cb && cb({
      ok: true,
      id: socket.id,
      state: snapshot(room),
      members: memberList(room),
      sharedUrl: room.sharedUrl,
    });
    io.to(code).emit('members', memberList(room));
    socket.to(code).emit('system', `${room.members.get(socket.id).name} joined`);
  });

  socket.on('control', ({ action, time }) => {
    if (!current) return;
    const room = current;
    freeze(room);
    if (typeof time === 'number' && isFinite(time)) room.time = Math.max(0, time);
    if (action === 'play') room.playing = true;
    if (action === 'pause') room.playing = false;
    room.updatedAt = Date.now();
    broadcastState(room, socket.id);
  });

  socket.on('buffering', () => {
    if (!current) return;
    freeze(current);
    current.waiting.add(socket.id);
    broadcastState(current, socket.id);
  });

  socket.on('ready', () => {
    if (!current || !current.waiting.has(socket.id)) return;
    freeze(current);
    current.waiting.delete(socket.id);
    broadcastState(current, socket.id);
  });

  socket.on('file', (file) => {
    if (!current) return;
    const m = current.members.get(socket.id);
    if (!m) return;
    m.file = file && file.name ? { name: String(file.name).slice(0, 200), size: Number(file.size) || 0 } : null;
    io.to(current.code).emit('members', memberList(current));
  });

  socket.on('shared-url', (url) => {
    if (!current) return;
    url = String(url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) return;
    current.sharedUrl = url || null;
    freeze(current);
    current.time = 0;
    current.playing = false;
    io.to(current.code).emit('shared-url', { url: current.sharedUrl, by: current.members.get(socket.id)?.name });
    broadcastState(current, socket.id);
  });

  socket.on('chat', (text) => {
    if (!current) return;
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    io.to(current.code).emit('chat', {
      id: socket.id,
      name: current.members.get(socket.id)?.name || 'Guest',
      text,
      at: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    if (!current) return;
    const room = current;
    const name = room.members.get(socket.id)?.name;
    freeze(room);
    room.waiting.delete(socket.id);
    room.members.delete(socket.id);
    if (room.members.size === 0) {
      rooms.delete(room.code);
      return;
    }
    io.to(room.code).emit('members', memberList(room));
    io.to(room.code).emit('system', `${name} left`);
    broadcastState(room, null);
  });
});

// Heartbeat: every 3s each room gets the authoritative position so clients can
// correct drift.
setInterval(() => {
  for (const room of rooms.values()) {
    io.to(room.code).emit('tick', snapshot(room));
  }
}, 3000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`JS Theatre running at http://localhost:${PORT}`));
