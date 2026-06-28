const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const axios      = require("axios");
const path       = require("path");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

const API_BASE      = "https://neontester.api.ionode.cloud/device/history";
const POLL_INTERVAL = 5000;
const LIMIT         = 50;

// Serve static files
app.use(express.static(path.join(__dirname)));

// ── Proxy paginated history for the table ───────────────────────────────────
app.get("/api/history", async (req, res) => {
  try {
    const page  = req.query.page  || 1;
    const limit = req.query.limit || LIMIT;
    const resp  = await axios.get(`${API_BASE}?page=${page}&limit=${limit}`);
    res.json(resp.data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── /api/all – fetch ALL pages for Excel download ───────────────────────────
app.get("/api/all", async (req, res) => {
  try {
    console.log("[Download] Fetching all records...");
    const first      = await axios.get(`${API_BASE}?page=1&limit=${LIMIT}`);
    const pagination = first.data.pagination || {};
    const totalPages = pagination.pages || 1;

    let allData = [...(first.data.data || [])];

    for (let p = 2; p <= totalPages; p++) {
      const resp = await axios.get(`${API_BASE}?page=${p}&limit=${LIMIT}`);
      allData = allData.concat(resp.data.data || []);
      console.log(`[Download] Page ${p}/${totalPages} – running total: ${allData.length}`);
    }

    console.log(`[Download] Done – ${allData.length} records`);
    res.json({ success: true, data: allData, total: allData.length });
  } catch (err) {
    console.error("[Download] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/delete-range – delete all records on a given page ────────────
app.delete("/api/delete-range", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  try {
    console.log(`[Delete] Fetching page ${page} records…`);
    const resp    = await axios.get(`${API_BASE}?page=${page}&limit=${LIMIT}`);
    const records = resp.data.data || [];

    if (!records.length) {
      return res.json({ success: true, deleted: 0, errors: 0, message: "No records found on this page" });
    }

    let deleted = 0, errors = 0;
    for (const record of records) {
      try {
        await axios.delete(`https://neontester.api.ionode.cloud/device/history/${record._id}`);
        deleted++;
        console.log(`[Delete] Deleted _id: ${record._id}`);
      } catch (e) {
        errors++;
        console.error(`[Delete] Failed _id ${record._id}:`, e.message);
      }
    }

    console.log(`[Delete] Done – deleted: ${deleted}, errors: ${errors}`);
    res.json({ success: true, deleted, errors, total: records.length });
  } catch (err) {
    console.error("[Delete] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── Socket.IO live polling ──────────────────────────────────────────────────
let lastTimestamp = null;

async function pollAPI() {
  if (io.engine.clientsCount === 0) return;
  try {
    const resp = await axios.get(`${API_BASE}?page=1&limit=5`);
    const data = resp.data.data || [];
    const pg   = resp.data.pagination || {};

    if (data.length > 0) {
      const latestTs = data[0].timestamp;
      if (latestTs !== lastTimestamp) {
        lastTimestamp = latestTs;
        io.emit("live-update", {
          latestRecord: data[0],
          total:        pg.total,
          updatedAt:    new Date().toISOString()
        });
        console.log("[Socket] New data emitted:", latestTs);
      }
    }
  } catch (err) {
    console.error("[Socket] Poll error:", err.message);
  }
}

setInterval(pollAPI, POLL_INTERVAL);

io.on("connection", (socket) => {
  console.log("[Socket] Client connected:", socket.id);
  socket.on("disconnect", () => console.log("[Socket] Disconnected:", socket.id));
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n  Neon DataLogs running -> http://localhost:${PORT}\n`);
});
