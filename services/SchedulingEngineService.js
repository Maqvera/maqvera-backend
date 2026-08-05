import VisaAppointmentModel from "../models/VisaAppointmentModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { VISA_CASE_STATUSES, VISA_DOMAIN_EVENTS } from "../utils/visaConstants.js";
import AppointmentProviderModel from "../models/AppointmentProviderModel.js";
import mongoose from "mongoose";

class SchedulingEngineService {
  /**
   * Auto-generate Appointment Number: APT-YYYY-XXXXXX
   */
  static async generateAppointmentNumber(tenantId) {
    const year = new Date().getFullYear();
    const prefix = `APT-${year}-`;
    const count = await VisaAppointmentModel.countDocuments({
      tenantId,
      appointmentNumber: new RegExp(`^${prefix}`)
    });
    return `${prefix}${String(count + 1).padStart(6, "0")}`;
  }

  /**
   * Schedule a New Appointment (with capacity & double-booking conflict check)
   */
  static async scheduleAppointment(visaCaseId, { appointmentType = "Biometric", providerId, providerName, locationId, location, appointmentDate, appointmentTime = "09:30", durationMinutes = 30, assignedOfficer, remarks }, tenantId, branchId, userId) {
    if (!visaCaseId || !appointmentDate || !providerId || !locationId) {
      throw new Error("visaCaseId, appointmentDate, providerId and locationId are required.");
    }

    const caseFilter = { _id: visaCaseId, tenantId, isSoftDeleted: { $ne: true } };
    if (branchId) caseFilter.branchId = branchId;
    const visaCase = await VisaCaseModel.findOne(caseFilter);
    if (!visaCase) {
      throw new Error("Visa Case not found.");
    }

    const apptDate = new Date(appointmentDate);
    if (Number.isNaN(apptDate.getTime()) || apptDate < new Date(new Date().setHours(0, 0, 0, 0))) throw new Error("Appointment date must be today or in the future.");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(appointmentTime)) throw new Error("appointmentTime must use HH:MM format.");

    let resolvedProvider = { name: providerName || providerId, location: { name: location || locationId, dailyCapacity: 1, slotCapacity: 1, openingTime: "00:00", closingTime: "23:59", blackoutDates: [] } };
    if (mongoose.connection.readyState === 1) {
      const provider = await AppointmentProviderModel.findOne({ tenantId, providerId, isActive: true });
      if (!provider) throw new Error("Appointment provider not found or inactive.");
      const providerLocation = provider.locations.find((item) => item.locationId === locationId);
      if (!providerLocation) throw new Error("Appointment provider location not found.");
      if (providerLocation.blackoutDates.includes(apptDate.toISOString().slice(0, 10))) throw new Error("Provider location is unavailable on the selected date.");
      if (appointmentTime < providerLocation.openingTime || appointmentTime >= providerLocation.closingTime) throw new Error("Selected appointment time is outside provider working hours.");
      resolvedProvider = { name: provider.name, location: providerLocation };
    }

    // Conflict & Double Booking Check (Same provider + location + date + time)
    const existingConflict = await VisaAppointmentModel.findOne({
      tenantId,
      providerId,
      locationId,
      appointmentDate: apptDate,
      appointmentTime,
      status: { $nin: ["Cancelled", "Rejected"] },
      isSoftDeleted: { $ne: true }
    });

    if (existingConflict && resolvedProvider.location.slotCapacity <= 1) {
      throw new Error(`Time slot ${appointmentTime} on ${apptDate.toISOString().split("T")[0]} is already booked for provider ${providerName || "VAC"}. Please select another slot.`);
    }
    // "Overbooking Policy ... Configurable" — allowance defaults to 0%,
    // which reproduces the previous strict >= behavior exactly.
    const overbookingAllowance = resolvedProvider.location.overbookingAllowancePercent || 0;
    const effectiveDailyCapacity = Math.floor(resolvedProvider.location.dailyCapacity * (1 + overbookingAllowance / 100));
    const effectiveSlotCapacity = Math.floor(resolvedProvider.location.slotCapacity * (1 + overbookingAllowance / 100));
    const dailyBookings = await VisaAppointmentModel.countDocuments({ tenantId, providerId, locationId, appointmentDate: apptDate, status: { $nin: ["Cancelled", "Rejected"] }, isSoftDeleted: { $ne: true } });
    if (dailyBookings >= effectiveDailyCapacity) throw new Error("Provider daily capacity has been reached.");
    const slotBookings = await VisaAppointmentModel.countDocuments({ tenantId, providerId, locationId, appointmentDate: apptDate, appointmentTime, status: { $nin: ["Cancelled", "Rejected"] }, isSoftDeleted: { $ne: true } });
    if (slotBookings >= effectiveSlotCapacity) throw new Error("Appointment time slot capacity has been reached.");

    const appointmentNumber = await this.generateAppointmentNumber(tenantId);

    // Auto-generate Reminder Schedule (7d, 3d, 1d, 2h before)
    const reminders = [];
    const tMinus7Days = new Date(apptDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    const tMinus3Days = new Date(apptDate.getTime() - 3 * 24 * 60 * 60 * 1000);
    const tMinus1Day = new Date(apptDate.getTime() - 1 * 24 * 60 * 60 * 1000);
    const appointmentAt = new Date(`${apptDate.toISOString().slice(0, 10)}T${appointmentTime}:00`);
    const tMinus2Hours = new Date(appointmentAt.getTime() - 2 * 60 * 60 * 1000);
    if (tMinus7Days > new Date()) reminders.push({ channel: "Email", scheduledFor: tMinus7Days, status: "pending" });
    if (tMinus3Days > new Date()) reminders.push({ channel: "WhatsApp", scheduledFor: tMinus3Days, status: "pending" });
    if (tMinus1Day > new Date()) reminders.push({ channel: "SMS", scheduledFor: tMinus1Day, status: "pending" });
    if (tMinus2Hours > new Date()) reminders.push({ channel: "Push", scheduledFor: tMinus2Hours, status: "pending" });

    const newAppt = new VisaAppointmentModel({
      tenantId,
      branchId: branchId || visaCase.branchId || "main",
      appointmentNumber,
      visaCaseId,
      caseNumber: visaCase.caseNumber,
      travelerId: visaCase.travelerId,
      appointmentType,
      providerId: providerId || null,
      providerName: resolvedProvider.name,
      locationId,
      location: resolvedProvider.location.name,
      appointmentDate: apptDate,
      appointmentTime,
      durationMinutes,
      assignedOfficer: assignedOfficer || null,
      status: "Scheduled",
      attendance: { status: "pending" },
      result: { outcome: "pending" },
      reminders,
      remarks
    });

    await newAppt.save();

    // Sync to Visa Case aggregate
    visaCase.appointments.push({
      appointmentType: appointmentType.toLowerCase().includes("bio") ? "biometrics" : appointmentType.toLowerCase().includes("interv") ? "interview" : appointmentType.toLowerCase().includes("medic") ? "medical" : "custom",
      appointmentDate: apptDate,
      location: resolvedProvider.location.name,
      status: "scheduled",
      referenceNumber: appointmentNumber,
      notes: remarks || null
    });

    if (appointmentType.toLowerCase().includes("interv")) {
      visaCase.status = VISA_CASE_STATUSES.INTERVIEW_SCHEDULED;
    } else if (appointmentType.toLowerCase().includes("medic")) {
      visaCase.status = VISA_CASE_STATUSES.MEDICAL_SCHEDULED;
    }

    visaCase.timeline.push({
      event: "AppointmentScheduled",
      description: `${appointmentType} appointment scheduled for ${apptDate.toISOString().split("T")[0]} at ${appointmentTime} (Ref: ${appointmentNumber}).`,
      performedBy: userId || "system",
      timestamp: new Date()
    });

    await visaCase.save();

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "SCHEDULE_APPOINTMENT",
      resource: "VisaAppointment",
      resourceId: newAppt._id.toString(),
      details: { appointmentNumber, visaCaseId, appointmentType, appointmentDate: apptDate }
    }).catch(err => console.error("Audit error:", err));

    publishEvent("AppointmentScheduled", { appointmentId: newAppt._id, visaCaseId, tenantId, branchId: newAppt.branchId });

    return newAppt;
  }

  /**
   * Get all appointments for a Visa Case
   */
  static async getAppointmentsForCase(visaCaseId, query, tenantId, branchId) {
    const filter = {
      tenantId,
      visaCaseId,
      isSoftDeleted: { $ne: true }
    };

    if (branchId) filter.branchId = branchId;
    if (query.status) filter.status = query.status;
    if (query.appointmentType) filter.appointmentType = new RegExp(`^${query.appointmentType}$`, "i");
    const page = Math.max(Number(query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize) || 20, 1), 100);
    const [appointments, total] = await Promise.all([
      VisaAppointmentModel.find(filter).sort({ appointmentDate: 1, appointmentTime: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      VisaAppointmentModel.countDocuments(filter)
    ]);
    return {
      visaCaseId,
      count: total, appointments,
      pagination: { page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) || 1 }
    };
  }

  /**
   * Update or Reschedule Appointment
   */
  static async updateAppointment(appointmentId, updateData, tenantId, userId) {
    const appt = await VisaAppointmentModel.findOne({ _id: appointmentId, tenantId, isSoftDeleted: { $ne: true } });
    if (!appt) {
      throw new Error("Appointment not found.");
    }

    if (appt.status === "Completed") {
      throw new Error("Completed appointments cannot be modified.");
    }

    let isRescheduled = false;
    const oldDate = appt.appointmentDate;
    const oldTime = appt.appointmentTime;

    if (updateData.appointmentDate || updateData.appointmentTime) {
      const newDate = updateData.appointmentDate ? new Date(updateData.appointmentDate) : oldDate;
      const newTime = updateData.appointmentTime || oldTime;

      if (newDate.getTime() !== oldDate.getTime() || newTime !== oldTime) {
        isRescheduled = true;

        // Perform Conflict Check for new slot
        const conflict = await VisaAppointmentModel.findOne({
          tenantId,
          _id: { $ne: appt._id },
          providerName: appt.providerName,
          appointmentDate: newDate,
          appointmentTime: newTime,
          status: { $nin: ["Cancelled", "Rejected"] },
          isSoftDeleted: { $ne: true }
        });

        if (conflict) {
          throw new Error(`Slot ${newTime} on ${newDate.toISOString().split("T")[0]} is unavailable.`);
        }

        appt.rescheduleHistory.push({
          oldDate,
          oldTime,
          newDate,
          newTime,
          reason: updateData.remarks || "Rescheduled by user",
          rescheduledBy: userId || "system",
          rescheduledAt: new Date()
        });

        appt.appointmentDate = newDate;
        appt.appointmentTime = newTime;
        appt.status = "Rescheduled";
      }
    }

    // "Provider" / "Location" as editable fields previously only accepted a
    // display-string relabel (providerName/location), never actually
    // changing which real provider/location record the appointment points
    // to (providerId/locationId stayed untouched) — so it could drift out
    // of sync with the actual provider and skip re-validation entirely. A
    // real change re-validates exactly like scheduleAppointment does.
    if (updateData.providerId && updateData.locationId && (updateData.providerId !== appt.providerId || updateData.locationId !== appt.locationId)) {
      if (mongoose.connection.readyState === 1) {
        const provider = await AppointmentProviderModel.findOne({ tenantId, providerId: updateData.providerId, isActive: true });
        if (!provider) throw new Error("Appointment provider not found or inactive.");
        const providerLocation = provider.locations.find((item) => item.locationId === updateData.locationId);
        if (!providerLocation) throw new Error("Appointment provider location not found.");
        if (providerLocation.blackoutDates.includes(appt.appointmentDate.toISOString().slice(0, 10))) throw new Error("Provider location is unavailable on the selected date.");
        if (appt.appointmentTime < providerLocation.openingTime || appt.appointmentTime >= providerLocation.closingTime) throw new Error("Selected appointment time is outside provider working hours.");
        appt.providerId = updateData.providerId;
        appt.providerName = provider.name;
        appt.locationId = updateData.locationId;
        appt.location = providerLocation.name;
      } else {
        appt.providerId = updateData.providerId;
        appt.locationId = updateData.locationId;
        if (updateData.providerName) appt.providerName = updateData.providerName;
        if (updateData.location) appt.location = updateData.location;
      }
    } else {
      if (updateData.providerName) appt.providerName = updateData.providerName;
      if (updateData.location) appt.location = updateData.location;
    }
    if (updateData.remarks) appt.remarks = updateData.remarks;
    if (updateData.assignedOfficer) appt.assignedOfficer = updateData.assignedOfficer;
    if (updateData.priority) appt.priority = updateData.priority;

    await appt.save();

    // Update Case Timeline
    const visaCase = await VisaCaseModel.findOne({ _id: appt.visaCaseId, tenantId });
    if (visaCase) {
      visaCase.timeline.push({
        event: isRescheduled ? "AppointmentRescheduled" : "AppointmentUpdated",
        description: isRescheduled ? `Appointment ${appt.appointmentNumber} rescheduled to ${appt.appointmentDate.toISOString().split("T")[0]} ${appt.appointmentTime}.` : `Appointment ${appt.appointmentNumber} details updated.`,
        performedBy: userId || "system",
        timestamp: new Date()
      });
      await visaCase.save();
    }

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: isRescheduled ? "RESCHEDULE_APPOINTMENT" : "UPDATE_APPOINTMENT",
      resource: "VisaAppointment",
      resourceId: appt._id.toString(),
      details: updateData
    }).catch(err => console.error("Audit error:", err));

    publishEvent(isRescheduled ? "AppointmentRescheduled" : "AppointmentUpdated", { appointmentId: appt._id, visaCaseId: appt.visaCaseId, tenantId, branchId: appt.branchId });

    return appt;
  }

  /**
   * Record Attendance
   */
  static async recordAttendance(appointmentId, { status = "checked_in", checkInTime = new Date() }, tenantId, userId) {
    const appt = await VisaAppointmentModel.findOne({ _id: appointmentId, tenantId, isSoftDeleted: { $ne: true } });
    if (!appt) {
      throw new Error("Appointment not found.");
    }

    appt.attendance = {
      status,
      checkInTime: new Date(checkInTime),
      markedBy: userId || "system",
      markedAt: new Date()
    };

    if (status === "checked_in" || status === "present") {
      appt.status = "Checked In";
    } else if (status === "no_show") {
      appt.status = "No Show";
    } else if (status === "cancelled") {
      appt.status = "Cancelled";
    }

    await appt.save();

    const visaCase = await VisaCaseModel.findOne({ _id: appt.visaCaseId, tenantId });
    if (visaCase) {
      visaCase.timeline.push({
        event: "AppointmentAttendanceRecorded",
        description: `Attendance for ${appt.appointmentType} (${appt.appointmentNumber}) marked as ${status}.`,
        performedBy: userId || "system",
        timestamp: new Date()
      });
      await visaCase.save();
    }

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "RECORD_APPOINTMENT_ATTENDANCE",
      resource: "VisaAppointment",
      resourceId: appt._id.toString(),
      details: { status, checkInTime }
    }).catch(err => console.error("Audit error:", err));

    publishEvent("AppointmentAttendanceRecorded", { appointmentId: appt._id, visaCaseId: appt.visaCaseId, status, tenantId, branchId: appt.branchId });

    // AppointmentAttendanceRecorded is generic across every attendance
    // status; AppointmentCheckedIn and AppointmentCancelled (named in the
    // Domain Event Map) were never published on their own.
    if (appt.status === "Checked In") {
      publishEvent("AppointmentCheckedIn", { appointmentId: appt._id, visaCaseId: appt.visaCaseId, tenantId, branchId: appt.branchId });
    } else if (appt.status === "Cancelled") {
      publishEvent("AppointmentCancelled", { appointmentId: appt._id, visaCaseId: appt.visaCaseId, tenantId, branchId: appt.branchId });
    }

    return appt;
  }

  /**
   * Record Outcome Result
   */
  static async recordAppointmentResult(appointmentId, { outcome, notes }, tenantId, userId) {
    if (!outcome) {
      throw new Error("Outcome result is required.");
    }

    const appt = await VisaAppointmentModel.findOne({ _id: appointmentId, tenantId, isSoftDeleted: { $ne: true } });
    if (!appt) {
      throw new Error("Appointment not found.");
    }

    appt.result = {
      outcome,
      notes: notes || null,
      recordedBy: userId || "system",
      recordedAt: new Date()
    };

    const isSuccess = ["Successful", "Interview Passed", "Biometric Completed"].includes(outcome);
    appt.status = isSuccess ? "Completed" : "Rejected";

    await appt.save();

    // Sync status to Visa Case
    const visaCase = await VisaCaseModel.findOne({ _id: appt.visaCaseId, tenantId });
    if (visaCase) {
      if (outcome === "Interview Passed") {
        visaCase.workflow.completedSteps.push("interview");
      } else if (outcome === "Biometric Completed") {
        visaCase.workflow.completedSteps.push("biometrics");
      }

      visaCase.timeline.push({
        event: "AppointmentResultRecorded",
        description: `Result recorded for ${appt.appointmentType} (${appt.appointmentNumber}): ${outcome}. ${notes || ""}`,
        performedBy: userId || "system",
        timestamp: new Date()
      });

      await visaCase.save();
    }

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "RECORD_APPOINTMENT_RESULT",
      resource: "VisaAppointment",
      resourceId: appt._id.toString(),
      details: { outcome, notes }
    }).catch(err => console.error("Audit error:", err));

    publishEvent("AppointmentResultRecorded", { appointmentId: appt._id, visaCaseId: appt.visaCaseId, outcome, tenantId, branchId: appt.branchId });
    publishEvent("AppointmentCompleted", { appointmentId: appt._id, visaCaseId: appt.visaCaseId, outcome, tenantId, branchId: appt.branchId });

    // AppointmentCompleted is generic across all appointment types;
    // InterviewCompleted/MedicalCompleted (named in the Domain Event Map)
    // were never published at all — nothing let a subscriber react
    // specifically to "an interview just finished" vs. any other appointment.
    const typeLower = String(appt.appointmentType || "").toLowerCase();
    if (isSuccess && typeLower.includes("interv")) {
      publishEvent(VISA_DOMAIN_EVENTS.INTERVIEW_COMPLETED, { appointmentId: appt._id, visaCaseId: appt.visaCaseId, outcome, tenantId, branchId: appt.branchId });
    } else if (isSuccess && typeLower.includes("medic")) {
      publishEvent(VISA_DOMAIN_EVENTS.MEDICAL_COMPLETED, { appointmentId: appt._id, visaCaseId: appt.visaCaseId, outcome, tenantId, branchId: appt.branchId });
    }

    return appt;
  }
}

export default SchedulingEngineService;
