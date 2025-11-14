const express = require("express");
const mqtt = require("mqtt");
const dotenv = require("dotenv");
const HealthData = require("../models/HealthData");
const SleepData = require("../models/SleepData");
const Device = require("../models/Device");
const User = require("../models/User");
const SPEC = require("../config/metricSpec");

dotenv.config();

const router = express.Router();

const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || "mqtt://172.105.98.123:1883";
const MQTT_USERNAME = process.env.MQTT_USERNAME || "doze";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "bK67ZwBHSWkl";

let client;

// ✅ Connect to MQTT Broker with MQTT v5 support
const connectMQTT = () => {
    client = mqtt.connect(MQTT_BROKER_URL, {
        username: MQTT_USERNAME,
        password: MQTT_PASSWORD,
        protocolVersion: 5, // Enable MQTT v5
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 1000,
        properties: {
            sessionExpiryInterval: 60 * 60, // Session expiry interval in seconds
        },
    });

    client.on("connect", async (connack) => {
        // console.log("✅ Connected to MQTT broker with MQTT v5");
        // console.log("Connack properties:", connack.properties);

        // Get all devices and subscribe to their topics
        try {
            const devices = await Device.find().select("deviceId");
            // console.log(`✅ Found ${devices.length} devices to subscribe`);

            devices.forEach((device) => {
                if (device.deviceId) {
                    subscribeToDeviceTopics(device.deviceId);
                }
            });
        } catch (err) {
            console.error("❌ Error fetching devices:", err);
        }
    });

    client.on("message", async (topic, message) => {
        console.log("📩 Raw MQTT message:", topic, message.toString());

        try {
            const data = JSON.parse(message.toString());
            const topicParts = topic.split("/");
            const deviceId = topicParts[1];

            if (!deviceId) {
                console.warn("⚠️ No device ID found in topic:", topic);
                return;
            }

            const device = await Device.findOne({ deviceId });
            if (device) {
                await Device.findByIdAndUpdate(device._id, {
                    status: "active",
                    lastActiveAt: new Date(),
                });
                // console.log(`✅ Updated device status to active: ${deviceId}`);
            } else {
                console.warn(`⚠️ Device not found in database: ${deviceId}`);
            }

            if (topic.includes("/health")) {

                const newData = data; // incoming payload

                const base = {
                    deviceId,
                    timestamp: new Date(),
                    temperature: newData.temperature || 0,
                    humidity: newData.humidity || 0,
                    iaq: newData.iaq || 0,
                    eco2: newData.eco2 || 0,
                    tvoc: newData.tvoc || 0,
                    etoh: newData.etoh || 0,
                    hrv: newData.hrv || 0,
                    stress: newData.stress || 0,
                    respiration: newData.resp || newData.respiration || 0,
                    heartRate: newData.hr || newData.heartRate || 0,
                    metrics: {
                        ...(newData.metrics || {})
                    },
                    signals: {
                        motion: newData.signals?.motion ?? null,
                        presence: newData.signals?.presence ?? null,
                        battery: newData.signals?.battery ?? null,
                        activity: newData.signals?.activity ?? null,
                        mic: newData.signals?.mic ?? null,
                        rrIntervals: newData.signals?.rrIntervals || [],
                        rawWaveform: newData.signals?.rawWaveform || []
                    },
                    raw: newData.raw || {}
                };

                // --- presence gating ---
                const presence = Number(base.signals.presence ?? 1);
                const state = presenceState.get(deviceId) || { lastPresence: 1, lastValues: {} };
                if (state.lastPresence === 1 && presence === 0) {
                    // retract last 12s
                    const cutoff = new Date(Date.now() - 12000);
                    const res = await HealthData.deleteMany({ deviceId, timestamp: { $gte: cutoff } });
                    console.log(`🔴 presence 1→0 for ${deviceId}, retracted ${res.deletedCount} docs`);
                }
                if (state.lastPresence === 0 && presence === 1) {
                    console.log(`🟢 presence 0→1 for ${deviceId}, resume immediately`);
                }
                state.lastPresence = presence;
                presenceState.set(deviceId, state);
                if (presence === 0) {
                    console.log(`⏸ skipped store (presence=0) for ${deviceId}`);
                    return;
                }

                // --- apply spec rules ---
                const rules = SPEC[device.deviceType]?.params || {};
                let violations = [];
                let changes = [];
                for (const [key, rule] of Object.entries(rules)) {
                    const value = newData[key] ?? base[key];
                    if (value == null) continue;
                    if (rule.min != null && value < rule.min) violations.push(`${key}<min`);
                    if (rule.max != null && value > rule.max) violations.push(`${key}>max`);
                    if (rule.mode === "onchange") {
                        if (state.lastValues[key] === value) continue; // skip no-change
                    }
                    changes.push(key);
                    state.lastValues[key] = value;
                }
                presenceState.set(deviceId, state);
                if (violations.length) {
                    console.log(`⚠️ ${deviceId} skipped (violations: ${violations.join(",")})`);
                    return;
                }
                if (!changes.length) {
                    console.log(`⚠️ ${deviceId} skipped (no-change values)`);
                    return;
                }

                // --- optional UART CSV parsing (if device sends UART lines) ---
                let mergedPatch = {};
                let mergedMetrics = {};
                let mergedSignals = {};
                let raws = [];

                const lines = Array.isArray(newData.lines)
                    ? newData.lines
                    : (newData.line ? [newData.line] : []);

                for (const ln of lines) {
                    const parsed = parseUartLine(String(ln));
                    if (!parsed) continue;
                    Object.assign(mergedPatch, parsed.patch);
                    Object.assign(mergedMetrics, parsed.metrics);
                    Object.assign(mergedSignals, parsed.signals);
                    raws.push(parsed.raw);
                }

                // collect extra flat metric keys if present
                const extraMetrics = {};
                [
                    "nn50", "sdsd", "mxdmn", "mo", "amo", "stress_ind",
                    "lf_pow", "hf_pow", "lf_hf_ratio", "bat", "mean_rr", "mean_hr",
                    "snore_num", "snore_freq", "pressure", "bvoc", "co2", "gas_percent",
                    "HRrest", "HRmax", "VO2max", "LactateThres", "TemperatureSkin",
                    "TemperatureEnv", "TemperatureCore", "ECG", "Barometer", "Accel",
                    "Gyro", "Magneto", "Steps", "Calories", "Distance", "BloodPressureSys",
                    "BloodPressureDia", "MuscleOxygenation", "GSR", "SleepStage",
                    "SleepQuality", "PostureFront", "PostureSide", "Fall", "BMI",
                    "BodyIndex", "ABSI", "Sports", "Start", "End", "NormalSinusRhythm",
                    "CHFAnalysis", "Diabetes", "TMT", "sdnn", "rmssd", "pnn50", "hr_median",
                    "rr_tri_index", "tin_rmssd", "sd1", "sd2", "lf", "hf", "lfhf",
                    "sample_entropy", "sd1sd2", "sns_index", "pns_index"
                ].forEach(k => {
                    if (newData[k] !== undefined) extraMetrics[k] = newData[k];
                });

                const newHealthData = new HealthData({
                    ...base,
                    ...mergedPatch,
                    metrics: { ...(newData.metrics || {}), ...mergedMetrics, ...extraMetrics },
                    signals: { ...(newData.signals || {}), ...mergedSignals },
                    raw: raws.length ? raws.join("\n") : base.raw
                });

                console.log("🚀 Final Save Payload:", JSON.stringify({
                    metrics: { ...(newData.metrics || {}), ...mergedMetrics },
                    signals: { ...(newData.signals || {}), ...mergedSignals }
                }, null, 2));

                await newHealthData.save();
                // console.log(`✅ Health data saved for device ${deviceId}`);
            } else if (topic.includes("/sleep")) {
                const newSleepData = new SleepData({
                    deviceId,
                    timestamp: new Date(),
                    sleepQuality: data.sleepQuality || "Unknown",
                    duration: data.duration || 0,
                });

                await newSleepData.save();
                // console.log(`✅ Sleep data saved for device ${deviceId}`);
            }
        } catch (error) {
            console.error("❌ Error processing MQTT message:", error);
        }
    });

    client.on("error", (error) => {
        console.error("❌ MQTT connection error:", error);
    });

    client.on("disconnect", () => {
        console.log("❌ Disconnected from MQTT broker");
    });

    client.on("reconnect", () => {
        console.log("🔄 Attempting to reconnect to MQTT broker");
    });

    return client;
};

// ✅ Subscribe to topics for a device
const subscribeToDeviceTopics = (deviceId) => {
    if (!client || !deviceId) {
        console.error("❌ Cannot subscribe: MQTT client not initialized or deviceId missing");
        return;
    }

    const healthTopic = `/${deviceId}/health`;
    const sleepTopic = `/${deviceId}/sleep`;

    client.subscribe([healthTopic, sleepTopic], { qos: 1 }, (err) => {
        if (err) {
            console.error(`❌ Failed to subscribe to topics for ${deviceId}:`, err);
        } else {
            // console.log(`✅ Subscribed to topics: ${healthTopic}, ${sleepTopic}`);
        }
    });
};

// ✅ Create API endpoint to subscribe to a new device's topics
router.post("/subscribe", async (req, res) => {
    try {
        const { deviceId } = req.body;

        if (!deviceId) {
            return res.status(400).json({ message: "Device ID is required" });
        }

        if (!client) {
            return res.status(500).json({ message: "MQTT client not initialized" });
        }

        subscribeToDeviceTopics(deviceId);
        res.json({ message: `Subscribed to topics for device ${deviceId}` });
    } catch (error) {
        console.error("Error subscribing to device topics:", error);
        res.status(500).json({ message: "Server error" });
    }
});


// ✅ Disconnect from MQTT Broker
const disconnectMQTT = () => {
    if (client) {
        client.end();
        console.log("❌ Disconnected from MQTT broker");
    }
};

// ✅ API Route to get MQTT connection status
router.get("/status", (req, res) => {
    const isConnected = client && client.connected;
    res.json({
        status: isConnected ? "connected" : "disconnected",
        message: isConnected ? "MQTT client is connected" : "MQTT client is not connected",
    });
});

// ✅ Export the router and functions properly
module.exports = {
    router,
    connectMQTT,
    disconnectMQTT,
    subscribeToDeviceTopics,
};