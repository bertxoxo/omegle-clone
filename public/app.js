// ---- Setup screen logic ----
const modeVideoBtn = document.getElementById("modeVideoBtn");
const modeTextBtn = document.getElementById("modeTextBtn");
const ageCheckbox = document.getElementById("ageCheckbox");
const startBtn = document.getElementById("startBtn");
const countryInput = document.getElementById("countryInput");
const tagsInput = document.getElementById("tagsInput");

let selectedMode = "video";

modeVideoBtn.addEventListener("click", () => {
  selectedMode = "video";
  modeVideoBtn.classList.add("active");
  modeTextBtn.classList.remove("active");
});
modeTextBtn.addEventListener("click", () => {
  selectedMode = "text";
  modeTextBtn.classList.add("active");
  modeVideoBtn.classList.remove("active");
});

ageCheckbox.addEventListener("change", () => {
  startBtn.disabled = !ageCheckbox.checked;
});

const setupScreen = document.getElementById("setupScreen");
const chatScreen = document.getElementById("chatScreen");
const statusLabel = document.getElementById("statusLabel");
const waitingDots = document.getElementById("waitingDots");
const videoGrid = document.getElementById("videoGrid");
const textOnlyNotice = document.getElementById("textOnlyNotice");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const chatLog = document.getElementById("chatLog");
const typingIndicator = document.getElementById("typingIndicator");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const nextBtn = document.getElementById("nextBtn");
const reportBtn = document.getElementById("reportBtn");
const backBtn = document.getElementById("backBtn");

const reportModal = document.getElementById("reportModal");
const reportReason = document.getElementById("reportReason");
const reportDetails = document.getElementById("reportDetails");
const cancelReport = document.getElementById("cancelReport");
const confirmReport = document.getElementById("confirmReport");

let socket = null;
let localStream = null;
let peerConnection = null;
let currentMode = "video";
let typingTimeout = null;

const ICE_SERVERS = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function logMessage(text, cls) {
  const div = document.createElement("div");
  div.className = "msg " + cls;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setStatus(text, waiting) {
  statusLabel.textContent = text;
  waitingDots.style.display = waiting ? "inline-flex" : "none";
}

startBtn.addEventListener("click", async () => {
  currentMode = selectedMode;
  setupScreen.style.display = "none";
  chatScreen.style.display = "block";
  chatLog.innerHTML = "";
  typingIndicator.style.display = "none";

  if (currentMode === "video") {
    videoGrid.style.display = "grid";
    textOnlyNotice.style.display = "none";
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
    } catch (err) {
      logMessage("Could not access camera/mic: " + err.message, "sys");
      videoGrid.style.display = "none";
      textOnlyNotice.style.display = "block";
      currentMode = "text";
    }
  } else {
    videoGrid.style.display = "none";
    textOnlyNotice.style.display = "block";
  }

  connectAndFindMatch();
});

function connectAndFindMatch() {
  socket = io();

  socket.on("connect", () => {
    socket.emit("find-match", {
      mode: currentMode,
      country: countryInput.value,
      tags: tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean),
    });
  });

  socket.on("waiting", () => {
    setStatus("Waiting for a match", true);
  });

  socket.on("matched", async ({ initiator }) => {
    setStatus("Connected to a stranger", false);
    typingIndicator.style.display = "none";
    logMessage("You are now chatting with a stranger.", "sys");
    if (currentMode === "video") {
      await setupPeerConnection(initiator);
    }
  });

  socket.on("partner-left", () => {
    setStatus("Stranger disconnected", false);
    typingIndicator.style.display = "none";
    logMessage("Stranger has disconnected.", "sys");
    teardownPeerConnection();
  });

  socket.on("signal", async (data) => {
    if (!peerConnection) return;
    if (data.sdp) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === "offer") {
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit("signal", { sdp: peerConnection.localDescription });
      }
    } else if (data.candidate) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.warn("ICE candidate error", e);
      }
    }
  });

  socket.on("chat-message", (data) => {
    typingIndicator.style.display = "none";
    logMessage("Stranger: " + data.text, "them");
  });

  socket.on("typing", (data) => {
    typingIndicator.style.display = data.typing ? "block" : "none";
  });

  socket.on("report-received", () => {
    logMessage("Your report was submitted. Thank you.", "sys");
  });
}

async function setupPeerConnection(initiator) {
  teardownPeerConnection();
  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  if (localStream) {
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  }

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", { candidate: event.candidate });
    }
  };

  if (initiator) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit("signal", { sdp: peerConnection.localDescription });
  }
}

function teardownPeerConnection() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  remoteVideo.srcObject = null;
}

sendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
});

chatInput.addEventListener("input", () => {
  if (!socket) return;
  socket.emit("typing", { typing: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket.emit("typing", { typing: false });
  }, 1200);
});

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !socket) return;
  clearTimeout(typingTimeout);
  socket.emit("typing", { typing: false });
  socket.emit("chat-message", { text });
  logMessage("You: " + text, "me");
  chatInput.value = "";
}

nextBtn.addEventListener("click", () => {
  if (!socket) return;
  teardownPeerConnection();
  socket.emit("next");
  setStatus("Finding a new match", true);
  typingIndicator.style.display = "none";
  chatLog.innerHTML = "";
  socket.emit("find-match", {
    mode: currentMode,
    country: countryInput.value,
    tags: tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean),
  });
});

backBtn.addEventListener("click", () => {
  endSession();
  chatScreen.style.display = "none";
  setupScreen.style.display = "block";
});

function endSession() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  teardownPeerConnection();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
}

reportBtn.addEventListener("click", () => {
  reportModal.style.display = "flex";
});
cancelReport.addEventListener("click", () => {
  reportModal.style.display = "none";
});
confirmReport.addEventListener("click", () => {
  if (socket) {
    socket.emit("report", {
      reason: reportReason.value,
      details: reportDetails.value,
    });
  }
  reportModal.style.display = "none";
  reportDetails.value = "";
});