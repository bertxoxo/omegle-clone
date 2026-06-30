/**
 * Signaling + matchmaking server.
 *
 * Matching rule:
 *  - A "filtered" user has country and/or tags set.
 *  - A "universal" user has no filters set at all.
 *  - Filtered <-> Filtered: only match if country matches (when both set)
 *    AND at least one shared tag (when both have tags set).
 *  - Filtered <-> Universal: always allowed (universal = open to anyone).
 *  - Universal <-> Universal: always allowed.
 *
 * This is an MVP scaffold. It does NOT include:
 *  - real age/ID verification
 *  - CSAM hash-matching / content moderation
 *  - persistent storage (reports are written to a local JSON file for now)
 * Those need real third-party integrations before this goes anywhere public.
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

// ---- In-memory state ----
// queue: array of waiting users { socketId, mode, country, tags }
const queue = [];
// active pairs: socketId -> partnerSocketId
const pairs = new Map();
// socketId -> profile (mode/country/tags), kept for report logging
const profiles = new Map();

const REPORTS_FILE = path.join(__dirname, "reports.json");
if (!fs.existsSync(REPORTS_FILE)) fs.writeFileSync(REPORTS_FILE, "[]");

function anonId(socketId) {
  // Don't log raw socket IDs in reports; hash them instead.
  return crypto.createHash("sha256").update(socketId).digest("hex").slice(0, 16);
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 10); // cap to avoid abuse
}

function isUniversal(profile) {
  return !profile.country && (!profile.tags || profile.tags.length === 0);
}

function isCompatible(a, b) {
  // Must be same chat mode (video vs text)
  if (a.mode !== b.mode) return false;

  const aUniversal = isUniversal(a);
  const bUniversal = isUniversal(b);

  if (aUniversal || bUniversal) return true;

  // Both filtered: country must match if both set one
  if (a.country && b.country && a.country !== b.country) return false;

  // Both filtered: need at least one overlapping tag if both set tags
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
      queue.splice(i, 1);
      return candidate;
    }
  }
  return null;
}

function removeFromQueue(socketId) {
  const idx = queue.findIndex((u) => u.socketId === socketId);
  if (idx !== -1) queue.splice(idx, 1);
}

function disconnectPair(socketId) {
  const partnerId = pairs.get(socketId);
  if (partnerId) {
    pairs.delete(socketId);
    pairs.delete(partnerId);
    io.to(partnerId).emit("partner-left");
  }
}

io.on("connection", (socket) => {
  socket.on("find-match", (data) => {
    const profile = {
      socketId: socket.id,
      mode: data.mode === "video" ? "video" : "text",
      country: (data.country || "").trim().toUpperCase() || null,
      tags: normalizeTags(data.tags),
    };
    profiles.set(socket.id, profile);

    // If already paired or queued, clean that up first
    disconnectPair(socket.id);
    removeFromQueue(socket.id);

    const match = findMatch(profile);
    if (match) {
      pairs.set(socket.id, match.socketId);
      pairs.set(match.socketId, socket.id);
      // The earlier-queued user (match) initiates the WebRTC offer
      io.to(match.socketId).emit("matched", { initiator: true });
      io.to(socket.id).emit("matched", { initiator: false });
    } else {
      queue.push(profile);
      socket.emit("waiting");
    }
  });

  // WebRTC signaling relay
  socket.on("signal", (data) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("signal", data);
    }
  });

  // Text chat relay
  socket.on("chat-message", (data) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("chat-message", { text: String(data.text || "").slice(0, 1000) });
    }
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
