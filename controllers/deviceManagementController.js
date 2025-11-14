const Device = require("../models/Device");
const DeviceModel = require("../models/DeviceModel");
const Manufacturer = require("../models/Manufacturer");
const SPEC = require("../config/metricSpec");
const presenceState = new Map(); // deviceId -> {lastPresence, lastValues:{}}
const User = require("../models/User");
const HealthData = require("../models/HealthData");

// Search devices by deviceId, deviceType, manufacturer, location, status
exports.searchDevices = async (req, res) => {
  try {
    const { q } = req.query;
    const query = q
      ? {
        $or: [
          { deviceId: { $regex: q, $options: "i" } },
          { deviceType: { $regex: q, $options: "i" } },
          { manufacturer: { $regex: q, $options: "i" } },
          { location: { $regex: q, $options: "i" } },
          { status: { $regex: q, $options: "i" } }
        ]
      }
      : {};
    const devices = await Device.find(query).sort({ createdAt: -1 });
    res.json({ status: "success", results: devices.length, data: devices });
  } catch (error) {
    res.status(500).json({ status: "fail", message: error.message });
  }
};

// Get all devices (with pagination)
exports.getAllDevices = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const total = await Device.countDocuments();
    const devices = await Device.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    res.json({
      status: "success",
      results: devices.length,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
      data: devices
    });
  } catch (error) {
    res.status(500).json({ status: "fail", message: error.message });
  }
};

// Get a single device by MongoDB ID
exports.getDeviceById = async (req, res) => {
  try {
    const device = await Device.findById(req.params.id);
    if (!device) return res.status(404).json({ status: "fail", message: "Device not found" });
    res.json({ status: "success", data: device });
  } catch (error) {
    res.status(500).json({ status: "fail", message: error.message });
  }
};

// Update a device by MongoDB ID
exports.updateDevice = async (req, res) => {
  try {
    const allowedFields = [
      "deviceId",
      "deviceType",
      "manufacturer",
      "firmwareVersion",
      "location",
      "status",
      "validity",
      "userId",
      "deviceModelId",
      "profileVersion",
      "lastActiveAt"
    ];

    // 1) Collect only allowed fields
    const updateData = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updateData[field] = req.body[field];
    }

    // 2) Normalize AFTER collecting
    if (typeof updateData.status === "string") {
      updateData.status = updateData.status.toLowerCase().trim(); // keep DB lowercase
    }
    if (updateData.validity) {
      updateData.validity = new Date(updateData.validity);
    }
    if (updateData.lastActiveAt) {
      updateData.lastActiveAt = new Date(updateData.lastActiveAt);
    }

    // 3) Update device
    const device = await Device.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    if (!device) {
      return res.status(404).json({ status: "fail", message: "Device not found" });
    }

    // 4) 🔥 Extra check: If device is deactivated and was user.activeDevice → clear it
    if (updateData.status === "inactive" && device.userId) {
      const user = await User.findById(device.userId);
      if (user && String(user.activeDevice) === String(device._id)) {
        user.activeDevice = null;
        await user.save();
        console.log(
          `Cleared activeDevice for user ${user.email} because device ${device.deviceId} was deactivated`
        );
      }
    }

    res.json({ status: "success", message: "Device updated", data: device });
  } catch (error) {
    console.error("Error updating device:", error);
    res.status(500).json({ status: "fail", message: error.message });
  }
};

// ✅ Delete a device by deviceId (since frontend passes deviceId, not _id)
exports.deleteDevice = async (req, res) => {
  try {
    const { id } = req.params; // here "id" is actually deviceId
    if (!id) {
      return res.status(400).json({ status: "fail", message: "Device ID is required" });
    }

    // Find device
    const device = await Device.findOne({ deviceId: id });
    if (!device) {
      return res.status(404).json({ status: "fail", message: "Device not found" });
    }

    // If this device is active for a user → clear it
    if (device.userId) {
      const user = await User.findById(device.userId);
      if (user && String(user.activeDevice) === String(device._id)) {
        user.activeDevice = null;
        await user.save();
        console.log(`🔴 Cleared activeDevice for user ${user.email} because device ${device.deviceId} was deleted`);
      }
    }

    // Delete device
    await Device.deleteOne({ _id: device._id });

    console.log(`🗑️ Deleted device ${device.deviceId} from DB`);
    res.json({ status: "success", message: `Device ${device.deviceId} deleted` });
  } catch (error) {
    console.error("Error deleting device:", error);
    res.status(500).json({ status: "fail", message: error.message });
  }
};


// controllers/deviceManagementController.js (or a dedicated publicController)
exports.getCodes = async (req, res) => {
  try {
    const models = await DeviceModel.find({}, "code name").lean();
    const manufacturers = await Manufacturer.find({}, "code name").lean();

    res.json({
      models,
      manufacturers,
      modelsByCode: Object.fromEntries(models.map(m => [m.code, m])),
      manufacturersByCode: Object.fromEntries(manufacturers.map(m => [m.code, m])),
    });
  } catch (err) {
    console.error("[API:/public/codes] error:", err.message);
    res.status(500).json({ message: "Failed to load codes" });
  }
};

// ✅ Clear active device
exports.setInactiveDevice = async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!deviceId) return res.status(400).json({ message: "Device ID is required" });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const device = await Device.findOneAndUpdate(
      { deviceId },
      { status: "inactive" },
      { new: true }
    );
    if (!device) return res.status(404).json({ message: "Device not found" });

    // ✅ remove from activeDevices array
    user.activeDevices = user.activeDevices.filter(
      id => String(id) !== String(device._id)
    );
    await user.save();

    res.json({
      message: `Device ${device.deviceId} set as inactive`,
      activeDevices: user.activeDevices,
      device,
    });
  } catch (err) {
    console.error("Error in setInactiveDevice:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// 📌 Get device history (last N records or by date range)
exports.getDeviceHistory = async (req, res) => {
  try {
    const { deviceId } = req.query;
    const limit = parseInt(req.query.limit) || 100;
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    if (!deviceId) {
      return res.status(400).json({ status: "fail", message: "deviceId is required" });
    }

    const q = { deviceId };
    if (from || to) q.timestamp = {};
    if (from) q.timestamp.$gte = from;
    if (to) q.timestamp.$lte = to;

    console.log(`[DeviceHistory] Fetching history for deviceId=${deviceId}, from=${from}, to=${to}, limit=${limit}`);

    // ✅ Explicit projection: include all relevant top-level fields
    const data = await HealthData.find(
      q,
      "timestamp deviceId heartRate respiration temperature humidity stress iaq eco2 tvoc pressure bvoc gasPercer metrics signals"
    )
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean(); // lean() to improve performance and return plain objects

    console.log(`[DeviceHistory] Found ${data.length} records for ${deviceId}`);

    // ✅ Add summary calculation excluding 0 or absence
    const matchFilter = {
      deviceId,
      heartRate: { $gt: 0 },
      "signals.presence": 1
    };
    if (from || to) matchFilter.timestamp = {};
    if (from) matchFilter.timestamp.$gte = from;
    if (to) matchFilter.timestamp.$lte = to;

    const summaryAgg = await HealthData.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          minHR: { $min: "$heartRate" },
          avgHR: { $avg: "$heartRate" },
          maxHR: { $max: "$heartRate" },
          count: { $sum: 1 },
        }
      }
    ]);

    const summary = summaryAgg[0] || { minHR: 0, avgHR: 0, maxHR: 0, count: 0 };
    console.log(`[DeviceHistory] Summary -> min=${summary.minHR?.toFixed?.(2)}, avg=${summary.avgHR?.toFixed?.(2)}, max=${summary.maxHR?.toFixed?.(2)}, count=${summary.count}`);

    // ✅ Return full dataset with extended fields
    res.json({
      status: "success",
      results: data.length,
      data,
      summary,
    });
  } catch (err) {
    console.error("[DeviceHistory] Error:", err);
    res.status(500).json({ status: "fail", message: err.message });
  }
};

// controllers/deviceManagementController.js
exports.setActiveDevice = async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!deviceId) return res.status(400).json({ message: "Device ID is required" });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const device = await Device.findOneAndUpdate(
      { deviceId },
      { status: "active", userId: user._id },
      { new: true }
    );
    if (!device) return res.status(404).json({ message: "Device not found" });

    // ✅ add to activeDevices array if not already included
    if (!user.activeDevices.some(id => String(id) === String(device._id))) {
      user.activeDevices.push(device._id);
      await user.save();
    }

    console.log(`🟢 Device ${device.deviceId} set as ACTIVE for user ${user.email}`);

    res.json({
      message: `Device ${device.deviceId} set as active`,
      activeDevices: user.activeDevices,
      device,
    });
  } catch (err) {
    console.error("Error in setActiveDevice:", err);
    res.status(500).json({ message: "Server error" });
  }
};
