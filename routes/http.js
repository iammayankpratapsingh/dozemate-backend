const express = require("express");
const dotenv = require("dotenv");
const HealthData = require("../models/HealthData");
const SleepData = require("../models/SleepData");
const Device = require("../models/Device");

dotenv.config();

const router = express.Router();

// --- UART helpers (keep inline to avoid new files)
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// Parse one UART CSV line -> { patch, metrics, signals }
function parseUartLine(line) {
  if (!line || typeof line !== "string") return null;
  const parts = line.trim().split(",").map(s => s.trim());
  const tag = (parts[0] || "").toUpperCase();

  const patch = {};    // goes to flat fields (temperature, heartRate, respiration, hrv, stress…)
  const metrics = {};  // goes to HealthData.metrics (HRV detail)
  const signals = {};  // goes to HealthData.signals (flags)

  switch (tag) {
    case "HRV_DATA": {
      // Expected order (17 values after tag):
      // mean_rr, sdnn, rmssd, pnn50, hr_median, rr_tri_index, tin_rmssd,
      // sd1, sd2, lf, hf, lfhf, sample_entropy, sd1sd2, sns_index, pns_index
      if (parts.length >= 17) {
        const [
          _,
          mean_rr, sdnn, rmssd, pnn50, hr_median, rr_tri_index, tin_rmssd,
          sd1, sd2, lf, hf, lfhf, sample_entropy, sd1sd2, sns_index, pns_index
        ] = parts;

        Object.assign(metrics, {
          mean_rr: toNum(mean_rr),
          sdnn: toNum(sdnn),
          rmssd: toNum(rmssd),
          pnn50: toNum(pnn50),
          hr_median: toNum(hr_median),
          rr_tri_index: toNum(rr_tri_index),
          tin_rmssd: toNum(tin_rmssd),
          sd1: toNum(sd1),
          sd2: toNum(sd2),
          lf: toNum(lf),
          hf: toNum(hf),
          lfhf: toNum(lfhf),
          sample_entropy: toNum(sample_entropy),
          sd1sd2: toNum(sd1sd2),
          sns_index: toNum(sns_index),
          pns_index: toNum(pns_index),
        });

        // Optional: keep legacy flats filled if present
        if (metrics.rmssd !== undefined) patch.hrv = metrics.rmssd;
        if (metrics.hr_median !== undefined) patch.heartRate = metrics.hr_median;
      }
      break;
    }

    case "TEMP_HUM":
      patch.temperature = toNum(parts[1]);
      patch.humidity = toNum(parts[2]);
      break;

    case "HR":
      patch.heartRate = toNum(parts[1]);
      break;

    case "RES":
      patch.respiration = toNum(parts[1]);
      break;

    case "STRESS":
      patch.stress = toNum(parts[1]);
      break;

    case "RR":
      // optional raw RR sample (not always present)
      if (!("sample_entropy" in metrics)) metrics.sample_entropy = undefined;
      break;

    case "MOTION":
      signals.motion = parts[1] !== undefined ? Number(parts[1]) === 1 : undefined;
      break;

    case "PRESENCE":
      signals.presence = parts[1] !== undefined ? Number(parts[1]) === 1 : undefined;
      break;

    case "ACT":
    case "ACTIVITY":
      signals.activity = toNum(parts[1]);
      break;

    case "BAT":
      signals.battery = toNum(parts[1]);
      break;

    case "MIC":
      signals.mic = toNum(parts[1]);
      break;

    default:
      // leave unrecognized as raw only
      break;
  }

  return { patch, metrics, signals, raw: line };
}

router.post("/ingest", async (req, res) => {
  try {
    const { deviceId, type, data } = req.body;

    if (!deviceId || !type || !data) {
      return res.status(400).json({ message: "deviceId, type, and data are required" });
    }

    const device = await Device.findOne({ deviceId });
    if (!device) {
      return res.status(404).json({ message: `Device ${deviceId} not found` });
    }

    await Device.findByIdAndUpdate(device._id, {
      status: "active",
      lastActiveAt: new Date(),
    });

    if (type === "health") {

      console.log("Incoming data:", JSON.stringify(data, null, 2));


      const base = {
        deviceId,
        timestamp: new Date(),
        temperature: data.temperature || 0,
        humidity: data.humidity || 0,
        iaq: data.iaq || 0,
        eco2: data.eco2 || 0,
        tvoc: data.tvoc || 0,
        etoh: data.etoh || 0,
        hrv: data.hrv || 0,
        stress: data.stress || 0,
        respiration: data.resp || data.respiration || 0,
        heartRate: data.hr || data.heartRate || 0,
        metrics: {
          ...(data.metrics || {})
        },
        signals: {
          motion: data.signals?.motion ?? null,
          presence: data.signals?.presence ?? null,
          battery: data.signals?.battery ?? null,
          activity: data.signals?.activity ?? null,
          mic: data.signals?.mic ?? null,
          rrIntervals: data.signals?.rrIntervals || [],
          rawWaveform: data.signals?.rawWaveform || []
        },
        raw: data.raw || {}
      };


      // NEW: accept a single UART line or an array of lines and fold into the same doc
      let mergedPatch = {};
      let mergedMetrics = {};
      let mergedSignals = {};
      let raws = [];



      const lines = Array.isArray(data.lines) ? data.lines : (data.line ? [data.line] : []);
      for (const ln of lines) {
        const parsed = parseUartLine(String(ln));
        if (!parsed) continue;
        Object.assign(mergedPatch, parsed.patch);
        Object.assign(mergedMetrics, parsed.metrics);
        Object.assign(mergedSignals, parsed.signals);
        raws.push(parsed.raw);
      }

      // Final document (legacy fields preserved, UART merged if present)
      const newHealthData = new HealthData({
        ...base,
        ...mergedPatch,
        metrics: { ...base.metrics, ...mergedMetrics },
        signals: { ...base.signals, ...mergedSignals },  // 👈 MERGE both
        raw: raws.length ? raws.join("\n") : base.raw
      });

      await newHealthData.save();
      return res.json({ message: "Health data saved via http" });
    }

    if (type === "sleep") {
      const newSleepData = new SleepData({
        deviceId,
        timestamp: new Date(),
        sleepQuality: data.sleepQuality || "Unknown",
        duration: data.duration || 0,
      });

      await newSleepData.save();
      return res.json({ message: "Sleep data saved" });
    }

    return res.status(400).json({ message: "Invalid type. Use 'health' or 'sleep'" });

  } catch (err) {
    console.error("❌ Error saving data via HTTP:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;