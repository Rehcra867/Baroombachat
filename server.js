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

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

let rooms = {};
const MAX_MESSAGES_PER_ROOM = 500;

// ---- Logging with daily rotation ----
function logFileForToday() {
  const now = new Date();
  const local = now.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }); // e.g. 06/11/2025
  const [day, month, year] = local.split("/");
  return path.join(LOG_DIR, `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}.log`);
}

function logEvent(type, data = {}) {
  const entry = { timestamp: new Date().toISOString(), type, ...data };
  fs.appendFile(logFileForToday(), JSON.stringify(entry) + "\n", (err) => {
    if (err) console.error("logEvent error:", err);
  });
}

// --- Load saved rooms ---
if (fs.existsSync(ROOMS_FILE)) {
  try {
    rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8"));
  } catch {
    rooms = {};
  }
}

function saveRooms() {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2));
}

function hashPassword(pw) {
  return pw ? crypto.createHash("sha256").update(pw).digest("hex") : null;
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

      // ✍️ Typing indicator
  socket.on("typing", (room) => {
    if (!room || !socket.username) return;
    socket.to(room).emit("user typing", socket.username);
  });

  // 🚨 Message reports
  socket.on("report message", ({ room, id, reason }) => {
    if (!room || !id || !reason) return;
    logEvent("message_report", {
      room,
      by: socket.username || "unknown",
      id,
      reason,
    });
    
  });

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
    cb({
      ok: true,
      history: rooms[roomName].messages || [],
      hasPassword: !!rooms[roomName].passwordHash,
    });
  });

  // 💬 Chat messages with unique IDs
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

  // 🗑️ Admin: delete message by ID
  socket.on("delete message", ({ room, id }, cb) => {
    if (!socket.isAdmin) return cb && cb({ ok: false, error: "Not authorized" });
    if (!rooms[room]) return cb && cb({ ok: false, error: "Room not found" });

    const list = rooms[room].messages;
    const idx = list.findIndex((m) => m.id === id);
    if (idx === -1) return cb && cb({ ok: false, error: "Message not found" });

    list.splice(idx, 1);
    saveRooms();
    io.to(room).emit("message deleted", id);
    logEvent("message_deleted", { room, by: socket.username, id });
    cb && cb({ ok: true });
  });

  // 🗑️ Admin: delete room
  socket.on("delete room", (room, cb) => {
    if (!socket.isAdmin) return cb && cb({ ok: false, error: "Not authorized" });
    if (!rooms[room]) return cb && cb({ ok: false, error: "Room not found" });
    delete rooms[room];
    saveRooms();
    io.emit("room deleted", room);
    logEvent("room_deleted", { room, by: socket.username });
    cb && cb({ ok: true });
  });

  socket.on("disconnect", () => {
    if (socket.room && socket.username) {
      io.to(socket.room).emit("system message", {
        text: `${socket.username} left the chat`,
      });
      logEvent("user_left", { room: socket.room, username: socket.username });
    }
  });
});

// --- Admin: list + download logs ---
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

