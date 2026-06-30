/**
 * Signaling + matchmaking server.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const queue = [];
const pairs = new Map();
const profiles = new Map();

const RELAXED_MATCH_DELAY_MS = 6000; // widen search after this long

const REPORTS_FILE = path.join(__dirname, "reports.json");
if (!fs.existsSync(REPORTS_FILE)) fs.writeFileSync(REPORTS_FILE, "[]");

function anonId(socketId) {
  return crypto.createHash("sha256").update(socketId).digest("hex").slice(0, 16);
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 10);
}

function isUniversal(profile) {
  return !profile.country && (!profile.tags || profile.tags.length === 0);
}

function isCompatible(a, b) {
  if (a.mode !== b.mode) return false;
  const aUniversal = isUniversal(a);
  const bUniversal = isUniversal(b);
  if (aUniversal || bUniversal) return true;
  if (a.country && b.country && a.country !== b.country) return false;
  if (a.tags.length && b.tags.length) {
    const overlap = a.tags.some((t) => b.tags.includes(t));
    if (!overlap) return false;
  }
  return true;
}

function findMatch(profile) {
  for (let i = 0; i < queue.length; i++) {
    const candidate = queue[i];
    if (candidate.socketId === profile.socketId) continue;
    if (isCompatible(profile, candidate)) {
      clearTimeout(candidate.relaxedTimer);
      queue.splice(i, 1);
      return candidate;
    }
  }
  return null;
}

function removeFromQueue(socketId) {
  const idx = queue.findIndex((u) => u.socketId === socketId);
  if (idx !== -1) {
    clearTimeout(queue[idx].relaxedTimer);
    queue.splice(idx, 1);
  }
}

function disconnectPair(socketId) {
  const partnerId = pairs.get(socketId);
  if (partnerId) {
    pairs.delete(socketId);
    pairs.delete(partnerId);
    io.to(partnerId).emit("partner-left");
  }
}

// After a delay, if a queued user still hasn't found a filtered match,
// pair them with anyone else waiting in the same mode, ignoring filters.
function tryRelaxedMatch(socketId) {
  const selfIdx = queue.findIndex((u) => u.socketId === socketId);
  if (selfIdx === -1) return; // already matched or left
  const profile = queue[selfIdx];

  const candidateIdx = queue.findIndex(
    (u) => u.socketId !== socketId && u.mode === profile.mode
  );

  if (candidateIdx !== -1) {
    const candidate = queue[candidateIdx];
    clearTimeout(candidate.relaxedTimer);
    clearTimeout(profile.relaxedTimer);

    [selfIdx, candidateIdx].sort((a, b) => b - a).forEach((i) => queue.splice(i, 1));

    pairs.set(profile.socketId, candidate.socketId);
    pairs.set(candidate.socketId, profile.socketId);
    io.to(candidate.socketId).emit("matched", { initiator: true });
    io.to(profile.socketId).emit("matched", { initiator: false });
  } else {
    profile.relaxedTimer = setTimeout(() => tryRelaxedMatch(socketId), RELAXED_MATCH_DELAY_MS);
  }
}

io.on("connection", (socket) => {
  socket.on("find-match", (data) => {
    const profile = {
      socketId: socket.id,
      mode: data.mode === "video" ? "video" : "text",
      country: (data.country || "").trim().toUpperCase() || null,
      tags: normalizeTags(data.tags),
      relaxedTimer: null,
    };
    profiles.set(socket.id, profile);

    disconnectPair(socket.id);
    removeFromQueue(socket.id);

    const match = findMatch(profile);
    if (match) {
      pairs.set(socket.id, match.socketId);
      pairs.set(match.socketId, socket.id);
      io.to(match.socketId).emit("matched", { initiator: true });
      io.to(socket.id).emit("matched", { initiator: false });
    } else {
      profile.relaxedTimer = setTimeout(() => tryRelaxedMatch(socket.id), RELAXED_MATCH_DELAY_MS);
      queue.push(profile);
      socket.emit("waiting");
    }
  });

  socket.on("signal", (data) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit("signal", data);
  });

  socket.on("chat-message", (data) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("chat-message", { text: String(data.text || "").slice(0, 1000) });
    }
  });

  socket.on("typing", (data) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit("typing", { typing: !!data.typing });
  });

  socket.on("next", () => {
    disconnectPair(socket.id);
    removeFromQueue(socket.id);
  });

  socket.on("report", (data) => {
    const partnerId = pairs.get(socket.id);
    const report = {
      timestamp: new Date().toISOString(),
      reporter: anonId(socket.id),
      reported: partnerId ? anonId(partnerId) : null,
      reason: String(data.reason || "unspecified").slice(0, 100),
      details: String(data.details || "").slice(0, 2000),
      priority: data.reason === "minor_concern" ? "HIGH" : "normal",
    };
    try {
      const existing = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
      existing.push(report);
      fs.writeFileSync(REPORTS_FILE, JSON.stringify(existing, null, 2));
    } catch (e) {
      console.error("Failed to write report:", e);
    }
    socket.emit("report-received");
  });

  socket.on("disconnect", () => {
    disconnectPair(socket.id);
    removeFromQueue(socket.id);
    profiles.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));