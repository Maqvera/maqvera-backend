import dotenv from 'dotenv';

dotenv.config();

const parseBoolean = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
};

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

const parseStringList = (value, fallback) => {
  const parsed = parseJson(value, fallback);
  if (!Array.isArray(parsed)) return fallback;
  return parsed.map((item) => `${item}`.trim().toLowerCase()).filter(Boolean);
};

export const getBookingConfig = () => ({
  defaultCurrency: process.env.DEFAULT_CURRENCY || 'USD',
  defaultBookingType: (process.env.DEFAULT_BOOKING_TYPE || 'umrah').toLowerCase(),
  defaultBookingStatus: (process.env.DEFAULT_BOOKING_STATUS || 'draft').toLowerCase(),
  defaultPriority: (process.env.DEFAULT_BOOKING_PRIORITY || 'normal').toLowerCase(),
  defaultPaymentStatus: (process.env.DEFAULT_PAYMENT_STATUS || 'unpaid').toLowerCase(),
  defaultVisaStatus: (process.env.DEFAULT_VISA_STATUS || 'pending').toLowerCase(),
  defaultTravelerType: (process.env.DEFAULT_TRAVELER_TYPE || 'adult').toLowerCase(),
  defaultTravelerStatus: (process.env.DEFAULT_TRAVELER_STATUS || 'registered').toLowerCase(),
  defaultServiceWorkflowStatus: (process.env.DEFAULT_SERVICE_WORKFLOW_STATUS || 'created').toLowerCase(),
  defaultServiceStatus: (process.env.DEFAULT_SERVICE_STATUS || 'active').toLowerCase(),
  defaultServicePriority: (process.env.DEFAULT_SERVICE_PRIORITY || 'normal').toLowerCase(),
  defaultDocumentStatus: process.env.DEFAULT_BOOKING_DOCUMENT_STATUS || 'pending_scan',
  autoCreateWorkflow: parseBoolean(process.env.AUTO_CREATE_BOOKING_WORKFLOW, true),
  // Validation Rule: "Maximum Travelers (Package Rules)" — no package catalog
  // exists yet to derive a per-package cap from, so this is a configurable
  // tenant-wide safety cap instead (see the flag in the Part 3 audit).
  maxTravelersPerBooking: parseInt(process.env.MAX_TRAVELERS_PER_BOOKING || '50', 10),
  defaultPageSize: parseInt(process.env.DEFAULT_BOOKING_PAGE_SIZE || '20', 10),
  maxPageSize: parseInt(process.env.MAX_BOOKING_PAGE_SIZE || '100', 10),
  bookingTypes: parseStringList(process.env.BOOKING_TYPES_JSON, ['umrah', 'hajj', 'visa_only', 'flight_only', 'hotel_only', 'transportation', 'holiday_package', 'corporate_travel', 'custom_package']),
  // Matches Part 5's "Booking Workflow Lifecycle" exactly. Superseded the
  // partially_paid/fully_paid/rejected states from the Part 1 approximation:
  // payment progress already has its own dedicated paymentStatuses list
  // below (that's where partially_paid/fully_paid actually belong), and
  // Part 5's detailed lifecycle doesn't carry a booking-level "rejected"
  // state at all (unlike Visa's workflow, which genuinely has one).
  bookingStatuses: parseStringList(process.env.BOOKING_STATUSES_JSON, ['draft', 'quotation', 'reserved', 'confirmed', 'deposit_received', 'visa_processing', 'ticket_issued', 'travel_ready', 'traveling', 'completed', 'cancelled', 'refund_requested', 'refund_completed', 'archived']),
  paymentStatuses: parseStringList(process.env.BOOKING_PAYMENT_STATUSES_JSON, ['unpaid', 'partially_paid', 'fully_paid', 'refunded']),
  visaStatuses: parseStringList(process.env.BOOKING_VISA_STATUSES_JSON, ['not_required', 'pending', 'submitted', 'processing', 'approved', 'rejected']),
  travelerTypes: parseStringList(process.env.BOOKING_TRAVELER_TYPES_JSON, ['adult', 'child', 'infant', 'senior_citizen', 'special_assistance', 'vip', 'mahram', 'dependent']),
  travelerStatuses: parseStringList(process.env.BOOKING_TRAVELER_STATUSES_JSON, ['registered', 'documents_pending', 'visa_processing', 'visa_approved', 'ticket_issued', 'checked_in', 'traveling', 'completed', 'cancelled', 'no_show', 'rejected']),
  // Matches Part 5's "Example Transition Table" exactly. approvalRequired/
  // approvalRole come from Part 5's "Approval Rules" section:
  //   Confirmed -> Cancelled requires Operations Manager approval.
  //   Cancelled -> Refund Requested requires Finance approval.
  //   Refund Requested -> Refund Completed requires Finance Manager approval.
  // "Reserved -> Confirm Booking -> Confirmed" is marked "Optional" in the
  // table (a third state beyond the engine's Yes/No approvalRequired, with
  // no stated trigger condition for when it becomes required) — treated as
  // not-required by default; set BOOKING_WORKFLOW_DEFINITIONS_JSON to
  // override if the business wants it enforced unconditionally.
  // Action names deliberately match the doc's exact wording ("Confirm
  // Booking", not "confirm_booking") — Part 5's own request example sends
  // {"action":"Confirm Booking"}, and WorkflowEngine.executeWorkflowTransition
  // matches case-insensitively but not underscore-vs-space-insensitively, so
  // a snake_case action name here would make the doc's own example fail.
  workflowTransitions: parseJson(process.env.BOOKING_WORKFLOW_DEFINITIONS_JSON, [
    { fromState: 'draft', action: 'Create Quotation', toState: 'quotation' },
    { fromState: 'quotation', action: 'Reserve', toState: 'reserved' },
    { fromState: 'reserved', action: 'Confirm Booking', toState: 'confirmed' },
    { fromState: 'confirmed', action: 'Receive Deposit', toState: 'deposit_received' },
    { fromState: 'deposit_received', action: 'Start Visa', toState: 'visa_processing' },
    { fromState: 'visa_processing', action: 'Issue Tickets', toState: 'ticket_issued' },
    { fromState: 'ticket_issued', action: 'Mark Travel Ready', toState: 'travel_ready' },
    { fromState: 'travel_ready', action: 'Start Journey', toState: 'traveling' },
    { fromState: 'traveling', action: 'Complete Trip', toState: 'completed' },
    { fromState: 'completed', action: 'Archive Booking', toState: 'archived' },
    { fromState: 'confirmed', action: 'Cancel Booking', toState: 'cancelled', approvalRequired: true, approvalRole: 'operations_manager' },
    { fromState: 'cancelled', action: 'Process Refund', toState: 'refund_requested', approvalRequired: true, approvalRole: 'finance' },
    { fromState: 'refund_requested', action: 'Approve Refund', toState: 'refund_completed', approvalRequired: true, approvalRole: 'finance_manager' },
    { fromState: 'draft', action: 'Cancel Booking', toState: 'cancelled' },
    { fromState: 'quotation', action: 'Cancel Booking', toState: 'cancelled' },
    { fromState: 'reserved', action: 'Cancel Booking', toState: 'cancelled' },
    // Part 6's Overview explicitly lists Visa Cancellation/Hotel Release/Seat
    // Release as real cancellation consequences, implying cancellation must
    // remain reachable deep into fulfillment — not just from "confirmed".
    // Treated as at least as sensitive as cancelling a confirmed booking, so
    // the same approval tier applies.
    { fromState: 'deposit_received', action: 'Cancel Booking', toState: 'cancelled', approvalRequired: true, approvalRole: 'operations_manager' },
    { fromState: 'visa_processing', action: 'Cancel Booking', toState: 'cancelled', approvalRequired: true, approvalRole: 'operations_manager' },
    { fromState: 'ticket_issued', action: 'Cancel Booking', toState: 'cancelled', approvalRequired: true, approvalRole: 'operations_manager' },
    { fromState: 'travel_ready', action: 'Cancel Booking', toState: 'cancelled', approvalRequired: true, approvalRole: 'operations_manager' },
    { fromState: 'traveling', action: 'Cancel Booking', toState: 'cancelled', approvalRequired: true, approvalRole: 'operations_manager' }
  ]),
  workflowStates: parseJson(process.env.BOOKING_WORKFLOW_STATES_JSON, [
    { stateId: 'draft', label: 'Draft', description: 'Initial state' },
    { stateId: 'quotation', label: 'Quotation', description: 'Quoted state' },
    { stateId: 'reserved', label: 'Reserved', description: 'Reserved state' },
    { stateId: 'confirmed', label: 'Confirmed', description: 'Confirmed state' },
    { stateId: 'deposit_received', label: 'Deposit Received', description: 'Deposit received' },
    { stateId: 'visa_processing', label: 'Visa Processing', description: 'Visa is being processed' },
    { stateId: 'ticket_issued', label: 'Ticket Issued', description: 'Tickets issued' },
    { stateId: 'travel_ready', label: 'Travel Ready', description: 'Travel ready' },
    { stateId: 'traveling', label: 'Traveling', description: 'In transit' },
    { stateId: 'completed', label: 'Completed', description: 'Completed state' },
    { stateId: 'archived', label: 'Archived', description: 'Archived state' },
    { stateId: 'cancelled', label: 'Cancelled', description: 'Cancelled state' },
    { stateId: 'refund_requested', label: 'Refund Requested', description: 'Refund requested' },
    { stateId: 'refund_completed', label: 'Refund Completed', description: 'Refund completed' }
  ]),
  serviceTypes: parseStringList(process.env.BOOKING_SERVICE_TYPES_JSON, ['package', 'flight', 'hotel', 'room', 'visa', 'transport', 'insurance', 'guide', 'meals', 'meal_plan', 'ziyarat', 'activity', 'addon', 'other']),
  serviceCategories: parseStringList(process.env.BOOKING_SERVICE_CATEGORIES_JSON, ['transportation', 'accommodation', 'immigration', 'insurance', 'tour', 'food', 'religious', 'entertainment', 'other']),
  serviceWorkflowStatuses: parseStringList(process.env.BOOKING_SERVICE_WORKFLOW_STATUSES_JSON, ['created', 'reserved', 'confirmed', 'in_progress', 'completed', 'cancelled', 'expired', 'failed']),
  supportedCurrencies: parseStringList(process.env.SUPPORTED_CURRENCIES_JSON, ['usd', 'sar', 'aed', 'eur', 'gbp'])
});
