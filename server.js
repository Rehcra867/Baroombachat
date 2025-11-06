const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const ADMIN_PASS = process.env.ADMIN_PASS || "changeme"; // 🔒 set this in Render
const ROOMS_FILE = path.join(__dirname, "rooms.json");
const LOG_DIR = path.join(__dirname, "logs");
const REPORTS_FILE = path.join(__dirname, "reports.json");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

let rooms = {};
let reports = [];
const MAX_MESSAGES_PER_ROOM = 500;

// Load rooms & reports
if (fs.existsSync(ROOMS_FILE)) {
  try { rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8")); } catch { rooms = {}; }
}
if (fs.existsSync(REPORTS_FILE)) {
  try { reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8")); } catch { reports = []; }
}

// Helpers
function saveRooms() {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2));
}
function saveReports() {
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));
}
function hashPassword(pw) {
  return pw ? crypto.createHash("sha256").update(pw).digest("hex") : null;
}
function logFileForToday() {
  const now = new Date();
  const local = now.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
  const [day, month, year] = local.split("/");
  return path.join(LOG_DIR, `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}.log`);
}
function logEvent(type, data = {}) {
  const entry = { timestamp: new Date().toISOString(), type, ...data };
  fs.appendFile(logFileForToday(), JSON.stringify(entry) + "\n", (err) => {
    if (err) console.error("logEvent error:", err);
  });
}

// --- Public API ---
app.get("/rooms", (req, res) => {
  const list = Object.keys(rooms).map((name) => ({
    name,
    createdAt: rooms[name].createdAt,
    hasPassword: !!rooms[name].passwordHash,
    messageCount: rooms[name].messages?.length || 0,
  }));
  res.json(list);
});

app.post("/rooms", (req, res) => {
  const { name, password } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Invalid room name" });
  const room = name.trim();
  if (rooms[room]) return res.status(409).json({ error: "Room already exists" });

  rooms[room] = {
    createdAt: Date.now(),
    passwordHash: password ? hashPassword(password) : null,
    messages: [],
  };
  saveRooms();
  logEvent("room_created", { room, by: req.ip });
  res.json({ ok: true, room });
});

// --- Socket.io handling ---
io.on("connection", (socket) => {
  socket.isAdmin = false;

  socket.on("admin login", (pw, cb) => {
    if (pw === ADMIN_PASS) {
      socket.isAdmin = true;
      cb({ ok: true });
      logEvent("admin_login", { ip: socket.handshake.address });
    } else cb({ ok: false });
  });

  socket.on("join room", ({ username, room, password, color, avatar }, cb) => {
    const roomName = room?.trim();
    if (!username || !roomName) return cb({ ok: false, error: "Missing fields" });

    if (!rooms[roomName]) {
      rooms[roomName] = {
        createdAt: Date.now(),
        passwordHash: password ? hashPassword(password) : null,
        messages: [],
      };
      saveRooms();
      logEvent("room_created", { room: roomName, by: username });
    } else if (rooms[roomName].passwordHash && !socket.isAdmin) {
      if (hashPassword(password) !== rooms[roomName].passwordHash)
        return cb({ ok: false, error: "Incorrect password" });
    }

    socket.join(roomName);
    socket.username = username;
    socket.room = roomName;
    socket.color = color;
    socket.avatar = avatar;

    io.to(roomName).emit("system message", { text: `${username} joined` });
    logEvent("user_joined", { room: roomName, username });
    
    // Get list of reported message IDs for this room
    const reportedIds = reports
      .filter((r) => r.room === roomName)
      .map((r) => r.id);

    cb({
      ok: true,
      history: rooms[roomName].messages || [],
      hasPassword: !!rooms[roomName].passwordHash,
      reported: reportedIds, // ✅ send reported message IDs
    });

    cb({
      ok: true,
      history: rooms[roomName].messages || [],
      hasPassword: !!rooms[roomName].passwordHash,
    });
  });

  // 💬 Chat messages
  socket.on("chat message", (data) => {
    if (!data?.room || !data?.message) return;

    const msg = {
      id: crypto.randomUUID(),
      username: data.username || socket.username,
      message: data.message,
      color: data.color || socket.color,
      avatar: data.avatar || socket.avatar,
      timestamp: Date.now(),
    };

    if (!rooms[data.room]) return;
    rooms[data.room].messages.push(msg);
    if (rooms[data.room].messages.length > MAX_MESSAGES_PER_ROOM)
      rooms[data.room].messages.splice(0, 50);
    saveRooms();

    io.to(data.room).emit("chat message", msg);
    logEvent("message_posted", { room: data.room, username: msg.username, text: msg.message });
  });

  // 🗑️ Admin delete
  socket.on("delete message", ({ room, id }, cb) => {
    if (!socket.isAdmin) return cb && cb({ ok: false, error: "Not authorized" });
    if (!rooms[room]) return cb && cb({ ok: false, error: "Room not found" });

    const list = rooms[room].messages;
    const idx = list.findIndex((m) => m.id === id);
    if (idx === -1) return cb && cb({ ok: false, error: "Message not found" });

    list.splice(idx, 1);
    saveRooms();
    io.to(room).emit("message deleted", id);
    // remove from reports if it was reported
    reports = reports.filter((r) => !(r.room === room && r.id === id));
    saveReports();
    io.emit("report removed", { room, id });
    logEvent("message_deleted", { room, by: socket.username, id });
    cb && cb({ ok: true });
  });

  // 🧾 Report message
  socket.on("report message", ({ room, id, reporter }, cb) => {
    if (!rooms[room]) return cb && cb({ ok: false, error: "Room not found" });
    if (!id || !reporter) return cb && cb({ ok: false, error: "Missing fields" });

    // avoid duplicate reports
    if (reports.some((r) => r.room === room && r.id === id && r.reporter === reporter)) {
      return cb && cb({ ok: false, error: "Already reported" });
    }

    reports.push({ room, id, reporter, timestamp: Date.now() });
    saveReports();
    io.to(room).emit("message reported", { id });
    logEvent("message_reported", { room, id, reporter });
    cb && cb({ ok: true });
  });

  // 🧹 Admin unreport message
  socket.on("unreport message", ({ room, id }, cb) => {
    if (!socket.isAdmin) return cb && cb({ ok: false, error: "Not authorized" });
    const before = reports.length;
    reports = reports.filter(r => !(r.room === room && r.id === id));
    if (reports.length !== before) {
      saveReports();
      io.to(room).emit("report removed", { id });
      logEvent("message_unreported", { room, id, by: socket.username });
      cb && cb({ ok: true });
    } else {
      cb && cb({ ok: false, error: "Not found" });
    }
  });

  
  // Disconnect
  socket.on("disconnect", () => {
    if (socket.room && socket.username) {
      io.to(socket.room).emit("system message", { text: `${socket.username} left the chat` });
      logEvent("user_left", { room: socket.room, username: socket.username });
    }
  });
});

// --- Admin endpoints for logs & reports ---
app.get("/admin/loglist", (req, res) => {
  const pass = req.header("x-admin-pass") || req.query.pass;
  if (pass !== ADMIN_PASS) return res.status(403).send("Forbidden");
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith(".log"))
    .sort()
    .reverse();
  res.json(files);
});

app.get("/admin/logs", (req, res) => {
  const pass = req.header("x-admin-pass") || req.query.pass;
  if (pass !== ADMIN_PASS) return res.status(403).send("Forbidden");
  const file = req.query.file;
  if (!file) return res.status(400).send("Missing ?file=");
  const target = path.join(LOG_DIR, path.basename(file));
  if (!fs.existsSync(target)) return res.status(404).send("Log not found");
  res.download(target);
});

app.get("/admin/reports", (req, res) => {
  const pass = req.query.pass;
  if (pass !== ADMIN_PASS) return res.status(403).send("Forbidden");
  res.json(reports);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

