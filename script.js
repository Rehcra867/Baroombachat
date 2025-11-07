const socket = io();

// UI elements
const lobby = document.getElementById("lobby");
const roomsSelect = document.getElementById("rooms-select");
const usernameInput = document.getElementById("username-input");
const joinBtn = document.getElementById("join-btn");
const createBtn = document.getElementById("create-btn");
const refreshBtn = document.getElementById("refresh-rooms");
const deleteRoomBtn = document.getElementById("delete-room-btn");
const adminBtn = document.getElementById("admin-btn");
const logsSlot = document.getElementById("logs-slot");

const createModal = document.getElementById("create-modal");
const newRoomName = document.getElementById("new-room-name");
const newRoomPassword = document.getElementById("new-room-password");
const createConfirm = document.getElementById("create-room-confirm");
const createCancel = document.getElementById("create-room-cancel");

const chatPanel = document.getElementById("chat-panel");
const roomNameEl = document.getElementById("room-name");
const roomMetaEl = document.getElementById("room-meta");
const chatBox = document.getElementById("chat-box");
const chatForm = document.getElementById("chat-form");
const messageInput = document.getElementById("message-input");
const leaveBtn = document.getElementById("leave-btn");
const userAvatar = document.getElementById("user-avatar");
const userColorText = document.getElementById("user-color-text");

// state
let myUsername = "";
let myRoom = "";
let myColor = "";
let myAvatar = "";
let isAdmin = false;

// 🔐 ADMIN SYSTEM
adminBtn.addEventListener("click", () => {
  const pw = prompt("Enter admin password:");
  if (!pw) return;
  socket.emit("admin login", pw, (res) => {
    if (res.ok) {
      isAdmin = true;
      alert("✅ Admin mode activated");
      deleteRoomBtn.classList.remove("hidden");
      adminBtn.disabled = true;
      adminBtn.textContent = "Admin ✓";

      // 🧾 Logs button
      if (!document.getElementById("logs-btn")) {
        const logsBtn = document.createElement("button");
        logsBtn.id = "logs-btn";
        logsBtn.textContent = "Logs";
        logsBtn.addEventListener("click", async () => {
          const pass = prompt("Re-enter admin password:");
          if (!pass) return;
          try {
            const res = await fetch(`/admin/loglist?pass=${encodeURIComponent(pass)}`);
            if (!res.ok) return alert("Failed to get log list");
            const files = await res.json();
            if (!files.length) return alert("No logs found.");

            const choice = prompt(
              "Select a log to download:\n" +
              files.map((f, i) => `${i + 1}. ${f}`).join("\n")
            );
            const index = parseInt(choice);
            if (isNaN(index) || index < 1 || index > files.length) return;

            const selected = files[index - 1];
            const url = `/admin/logs?pass=${encodeURIComponent(pass)}&file=${encodeURIComponent(selected)}`;
            window.open(url, "_blank");
          } catch (err) {
            console.error(err);
            alert("Error fetching logs.");
          }
        });
        logsSlot.appendChild(logsBtn);
      }

      // 🧾 View Reports button
      if (!document.getElementById("reports-btn")) {
        const reportsBtn = document.createElement("button");
        reportsBtn.id = "reports-btn";
        reportsBtn.textContent = "View Reports";
        reportsBtn.addEventListener("click", async () => {
          const pass = prompt("Re-enter admin password:");
          if (!pass) return;
          try {
            const res = await fetch(`/admin/reports?pass=${encodeURIComponent(pass)}`);
            if (!res.ok) return alert("Failed to fetch reports.");
            const list = await res.json();
            if (!list.length) return alert("No reports available.");

            const choice = prompt(
              "Reported messages:\n" +
              list.map((r, i) => `${i + 1}. Room: ${r.room} | by: ${r.reporter}`).join("\n")
            );
            const index = parseInt(choice);
            if (isNaN(index) || index < 1 || index > list.length) return;

            const selected = list[index - 1];
            joinRoomFlow(selected.room, "");
            setTimeout(() => {
              const el = chatBox.querySelector(`[data-msg-id="${selected.id}"]`);
              if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "center" });
                el.style.boxShadow = "0 0 10px yellow";
                setTimeout(() => (el.style.boxShadow = ""), 2000);
              }
            }, 1500);
          } catch (err) {
            console.error(err);
            alert("Error fetching reports.");
          }
        });
        logsSlot.appendChild(reportsBtn);
      }
    } else {
      alert("❌ Incorrect password");
    }
  });
});

deleteRoomBtn.addEventListener("click", () => {
  const sel = roomsSelect.value;
  if (!sel) return alert("Select a room first.");
  if (!confirm(`Delete room "${sel}"?`)) return;
  socket.emit("delete room", sel, (res) => {
    if (res.ok) {
      alert("Room deleted successfully.");
      fetchRooms();
    } else {
      alert("Failed to delete room.");
    }
  });
});

socket.on("room deleted", (room) => {
  alert(`Room "${room}" was deleted by an admin.`);
  fetchRooms();
});

// Helpers
function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue} 70% 50%)`;
}

function setLocalIdentity(name) {
  if (!name) return;
  myUsername = name.trim();
  let stored = JSON.parse(localStorage.getItem("baroombachat_user") || "{}");
  stored.name = myUsername;
  if (!stored.color) stored.color = randomColor();
  stored.avatar = (
    myUsername.split(" ").map(s => s[0]).join("").slice(0, 2) ||
    myUsername.slice(0, 2)
  ).toUpperCase();
  localStorage.setItem("baroombachat_user", JSON.stringify(stored));
  myColor = stored.color;
  myAvatar = stored.avatar;
  updateAvatarUI();
}

function loadLocalIdentity() {
  const stored = JSON.parse(localStorage.getItem("baroombachat_user") || "{}");
  if (stored.name) myUsername = stored.name;
  if (stored.color) myColor = stored.color;
  if (stored.avatar) myAvatar = stored.avatar;
  if (myUsername) usernameInput.value = myUsername;
}

function updateAvatarUI() {
  userAvatar.style.background = myColor || "#666";
  userAvatar.textContent = myAvatar || (myUsername ? myUsername.slice(0, 2).toUpperCase() : "");
  userColorText.textContent = myUsername || "";
}

async function fetchRooms() {
  try {
    const res = await fetch("/rooms");
    const list = await res.json();
    populateRooms(list);
  } catch (err) {
    console.error("Failed to fetch rooms", err);
  }
}

function populateRooms(list) {
  roomsSelect.innerHTML = `<option value="">-- Select a room --</option>`;
  list.forEach(r => {
    const opt = document.createElement("option");
    opt.value = r.name;
    opt.textContent = `${r.name} ${r.hasPassword ? "(locked)" : ""} — ${r.messageCount} msgs`;
    roomsSelect.appendChild(opt);
  });
}

function addMessageElement(msg) {
  const el = document.createElement("div");
  el.classList.add("message");
  if (msg.id) el.dataset.msgId = msg.id;

  if (!msg.username) {
    el.classList.add("system-msg");
    el.textContent = msg.text || "";
    chatBox.appendChild(el);
    chatBox.scrollTop = chatBox.scrollHeight;
    return;
  }

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.style.background = msg.color || "#555";
  avatar.textContent = msg.avatar || msg.username.slice(0, 2).toUpperCase();

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const nameEl = document.createElement("div");
  nameEl.className = "msg-username";
  nameEl.textContent = msg.username;
  const timeEl = document.createElement("div");
  timeEl.className = "msg-time";
  timeEl.style.opacity = "0.7";
  timeEl.style.fontSize = "12px";
  timeEl.textContent = new Date(msg.timestamp || Date.now()).toLocaleString();
  meta.append(nameEl, timeEl);

  const textEl = document.createElement("div");
  textEl.className = "msg-text";
  textEl.textContent = msg.message;

  const content = document.createElement("div");
  content.style.display = "flex";
  content.style.flexDirection = "column";
  content.append(meta, textEl);

  el.append(avatar, content);

  // 🗑️ Admin-only delete button
  if (isAdmin) {
    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑️";
    delBtn.className = "msg-delete-btn";
    delBtn.style.marginLeft = "8px";
    delBtn.style.background = "transparent";
    delBtn.style.border = "none";
    delBtn.style.cursor = "pointer";
    delBtn.style.color = "#f55";
    delBtn.title = "Delete message";
    delBtn.addEventListener("click", () => {
      if (confirm("Delete this message?")) {
        const msgId = el.dataset.msgId;
        if (!msgId) return alert("Message has no ID (cannot delete).");
        socket.emit("delete message", { room: myRoom, id: msgId }, (res) => {
          if (!res?.ok) alert(res?.error || "Failed to delete message");
        });
      }
    });
    el.appendChild(delBtn);
  }

// Right-click: report (user) or unreport (admin)
el.addEventListener("contextmenu", (e) => {
  e.preventDefault();

  // 🧑‍💼 Admin: unreport
  if (isAdmin && el.classList.contains("reported")) {
    if (confirm("Unreport this message?")) {
      socket.emit("unreport message", { room: myRoom, id: msg.id }, (res) => {
        if (res.ok) el.classList.remove("reported");
        else alert(res.error || "Failed to unreport message");
      });
    }
    return;
  }

  // 🙋 Normal user: report
  if (!isAdmin) {
    if (el.classList.contains("reported")) return alert("You already reported this message.");
    if (confirm("Report this message?")) {
      socket.emit("report message", { room: myRoom, id: msg.id, reporter: myUsername }, (res) => {
        if (res.ok) el.classList.add("reported");
        else alert(res.error || "Failed to report message");
      });
    }
  }
});


  chatBox.appendChild(el);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Join a room
async function joinRoomFlow(roomToJoin, password) {
  if (!myUsername) return alert("Enter your name first.");
  myRoom = roomToJoin;
  socket.emit("join room", { username: myUsername, room: myRoom, password, color: myColor, avatar: myAvatar, admin: isAdmin }, (resp) => {
    if (!resp?.ok) return alert("Failed to join room: " + (resp.error || "Unknown error"));
    lobby.classList.add("hidden");
    chatPanel.classList.remove("hidden");
    roomNameEl.textContent = myRoom;
    roomMetaEl.textContent = `${resp.history.length} messages`;
    chatBox.innerHTML = "";
    resp.history.forEach(m => addMessageElement(m));
    updateAvatarUI();
    
    // Highlight any reported messages (for everyone)
    if (resp.reported && resp.reported.length) {
      resp.reported.forEach(id => {
        const el = chatBox.querySelector(`[data-msg-id="${id}"]`);
        if (el) el.classList.add("reported");
      });
    }

  });
}

function leaveRoom() {
  myRoom = "";
  chatPanel.classList.add("hidden");
  lobby.classList.remove("hidden");
  chatBox.innerHTML = "";
}

joinBtn.addEventListener("click", async () => {
  const sel = roomsSelect.value;
  const name = usernameInput.value.trim();
  if (!name) return alert("Enter your name.");
  setLocalIdentity(name);
  loadLocalIdentity();

  if (!sel) return alert("Choose a room.");
  try {
    const res = await fetch("/rooms");
    const list = await res.json();
    const chosen = list.find(r => r.name === sel);
    if (chosen && chosen.hasPassword && !isAdmin) {
      const pw = prompt("Password:");
      if (pw === null) return;
      joinRoomFlow(sel, pw);
    } else joinRoomFlow(sel, "");
  } catch (err) {
    console.error(err);
    joinRoomFlow(sel, "");
  }
});

createBtn.addEventListener("click", () => createModal.classList.remove("hidden"));
createCancel.addEventListener("click", () => createModal.classList.add("hidden"));

createConfirm.addEventListener("click", async () => {
  const room = newRoomName.value.trim();
  const pw = newRoomPassword.value;
  const name = usernameInput.value.trim();
  if (!name || !room) return alert("Enter name and room.");
  setLocalIdentity(name);
  try {
    const res = await fetch("/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: room, password: pw })
    });
    const json = await res.json();
    if (!res.ok) return alert(json.error || "Failed");
    createModal.classList.add("hidden");
    newRoomName.value = newRoomPassword.value = "";
    await fetchRooms();
    joinRoomFlow(room, pw);
  } catch (err) {
    console.error(err);
    alert("Error creating room");
  }
});

refreshBtn.addEventListener("click", fetchRooms);

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit("chat message", { room: myRoom, username: myUsername, message: text, color: myColor, avatar: myAvatar });
  messageInput.value = "";
});

leaveBtn.addEventListener("click", () => {
  leaveRoom();
  fetchRooms();
});

// 🔔 Events
socket.on("chat message", (msg) => addMessageElement(msg));
socket.on("system message", (data) => addMessageElement({ text: data.text || data }));
socket.on("message deleted", (id) => {
  const el = chatBox.querySelector(`[data-msg-id="${id}"]`);
  if (el) el.remove();
});
socket.on("message reported", ({ id }) => {
  const el = chatBox.querySelector(`[data-msg-id="${id}"]`);
  if (el) el.classList.add("reported");
});
socket.on("report removed", ({ id }) => {
  const el = chatBox.querySelector(`[data-msg-id="${id}"]`);
  if (el) el.classList.remove("reported");
});

// Init
loadLocalIdentity();
if (!myColor) myColor = randomColor();
if (!myAvatar && myUsername) myAvatar = myUsername.slice(0, 2).toUpperCase();
updateAvatarUI();
fetchRooms();

// === Terms & Instructions Popup ===
window.addEventListener("load", () => {
  const popup = document.getElementById("terms-popup");
  const agreeBtn = document.getElementById("agree-btn");

  // Show only if not accepted before
  const accepted = localStorage.getItem("baroombachat_termsAccepted");
  if (!accepted) {
    popup.classList.remove("hidden");
  }

  // Close popup when "I Agree" clicked
  agreeBtn.addEventListener("click", () => {
    localStorage.setItem("baroombachat_termsAccepted", "yes");
    popup.classList.add("hidden");
  });
});
