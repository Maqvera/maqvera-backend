import { publishEvent } from "./eventBus.js";
import BookingTimelineModel from "../models/BookingTimelineModel.js";
import BookingTaskModel from "../models/BookingTaskModel.js";
import BookingNoteModel from "../models/BookingNoteModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";

export const handleBookingCreatedSaga = async ({ booking, tenantId, requestId, authUser }) => {
  try {
    // Step 1: Default Task Generation
    await BookingTaskModel.create({
      bookingId: booking._id,
      tenantId,
      entityType: "Booking",
      entityId: booking._id,
      title: "Verify Customer Documents & Requirements",
      description: `Verify passport and visa requirements for customer ${booking.customerName}`,
      assignedTo: booking.assignedConsultant || booking.assignedTo || null,
      assignedToName: "Assigned Consultant",
      dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days
      priority: "normal",
      workflowStatus: "created",
      status: "active",
      createdBy: authUser?.id || null,
      createdByName: authUser?.username || "Staff"
    });

    // Step 2: System Welcome Note
    await BookingNoteModel.create({
      bookingId: booking._id,
      tenantId,
      entityType: "Booking",
      entityId: booking._id,
      authorId: authUser?.id || "system",
      authorName: authUser?.username || "System",
      category: "Operations",
      visibility: "Internal",
      content: `Booking Saga initiated for ${booking.bookingNumber}. Initial status: ${booking.status}.`,
      status: "active"
    });

    // Step 3: Timeline & Audit Saga Step
    await BookingTimelineModel.create({
      bookingId: booking._id,
      tenantId,
      entityType: "Booking",
      entityId: booking._id,
      module: "BookingSaga",
      eventType: "BookingSagaInitiated",
      title: "Booking Saga Initiated",
      description: `Automated saga orchestration executed for ${booking.bookingNumber}`,
      performedBy: authUser?.id || null,
      performedByName: authUser?.username || "System"
    });

    await AuditLogModel.create({
      action: "booking.saga.initiated",
      outcome: "success",
      reason: null,
      userId: authUser?.id || null,
      tenantId,
      branchId: booking.branchId,
      requestId,
      metadata: { bookingId: booking._id, saga: "BookingCreatedSaga" }
    });

    // Step 4: Event Publishing for Async Consumers (Finance, Visa, Analytics)
    publishEvent("BookingSagaCompleted", { bookingId: booking._id.toString(), tenantId });
  } catch (error) {
    console.error("handleBookingCreatedSaga error:", error);
    // Compensation Step
    publishEvent("BookingSagaCompensationTriggered", { bookingId: booking._id.toString(), tenantId, error: error.message });
  }
};
