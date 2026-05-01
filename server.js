const express = require("express");
const cors    = require("cors");
const { getStats } = require("./airdrop");

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

app.get("/stats", (req, res) => {
  const s = getStats();
  res.json({
    totalRounds:            s.totalRounds,
    totalSolDistributed:    parseFloat(s.totalSolDistributed.toFixed(6)),
    totalWalletsAirdropped: s.totalWalletsAirdropped,
    lastRound:              s.lastRound,
    recentDrops:            s.history.slice(0, 20),
  });
});

app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

app.get("/overlay", (req, res) => {
  res.sendFile(__dirname + "/overlay.html");
});

app.listen(PORT, () => {
  console.log(`🌐  Stats server running on port ${PORT}`);
  console.log(`   Overlay : http://localhost:${PORT}/overlay`);
  console.log(`   API     : http://localhost:${PORT}/stats`);
});
