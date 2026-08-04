import dotenv from 'dotenv';

dotenv.config();

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }
  return value;
};

export const getNotesTimelineConfig = () => ({
  // "Visibility Options... Configurable." Was a hardcoded Mongoose enum
  // with no env override. Kept in the doc's own Title-Case wording (matches
  // the existing schema enum's stored values).
  visibilityOptions: parseJson(process.env.NOTES_VISIBILITY_OPTIONS_JSON, [
    'Internal', 'Operations', 'Management', 'Customer Visible', 'Private'
  ]),

  // "Timeline Event Types... configurable" (22) and "Timeline Sources" (14)
  // are documented here for reference, but deliberately NOT enforced as a
  // hard enum on TravelTimelineModel.eventType/sourceModule: every other
  // Travel/Visa module already publishes its own specific, more granular
  // values (e.g. "FlightAssigned", "HotelStatusUpdated", "IncidentCreated")
  // that don't literally match this doc's generic category list — forcing
  // validation against it would break all of that existing, working event
  // publishing. Kept as an informational default set only.
  timelineEventTypes: parseJson(process.env.NOTES_TIMELINE_EVENT_TYPES_JSON, [
    'Created', 'Updated', 'Assigned', 'Cancelled', 'Approved', 'Rejected',
    'Checked In', 'Checked Out', 'Completed', 'Payment Received', 'Invoice Generated',
    'Traveler Added', 'Traveler Removed', 'Document Uploaded', 'Incident Reported',
    'Task Created', 'Task Completed', 'Notification Sent', 'AI Suggestion Generated',
    'Workflow Changed', 'Custom'
  ]),
  timelineSources: parseJson(process.env.NOTES_TIMELINE_SOURCES_JSON, [
    'Booking', 'Flight', 'Hotel', 'Transport', 'Itinerary', 'Attendance', 'Visa',
    'Finance', 'Communication', 'Incident', 'AI Assistant', 'Workflow Engine',
    'Authentication', 'System Scheduler'
  ]),

  // Attachments — "Supported Files" list, used as a real MIME-type
  // allowlist (same pattern as Incident attachments).
  attachmentAllowedMimeTypes: parseJson(process.env.NOTES_ATTACHMENT_MIME_TYPES_JSON, [
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'video/mp4', 'video/quicktime',
    'application/pdf',
    'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]),
  attachmentMaxSizeBytes: parseInt(process.env.NOTES_ATTACHMENT_MAX_SIZE_BYTES || '26214400', 10)
});
