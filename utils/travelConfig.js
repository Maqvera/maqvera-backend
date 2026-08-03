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

const parseStringList = (value, fallback) => {
  const parsed = parseJson(value, fallback);
  if (!Array.isArray(parsed)) return fallback;
  return parsed.map((item) => `${item}`.trim().toLowerCase()).filter(Boolean);
};

export const getTravelConfig = () => ({
  defaultTravelType: (process.env.DEFAULT_TRAVEL_TYPE || 'umrah').toLowerCase(),
  defaultTravelStatus: (process.env.DEFAULT_TRAVEL_STATUS || 'planning').toLowerCase(),
  defaultTravelPriority: (process.env.DEFAULT_TRAVEL_PRIORITY || 'normal').toLowerCase(),
  defaultPageSize: parseInt(process.env.DEFAULT_TRAVEL_PAGE_SIZE || '20', 10),
  maxPageSize: parseInt(process.env.MAX_TRAVEL_PAGE_SIZE || '100', 10),

  // Section 5 of the doc.
  travelTypes: parseStringList(process.env.TRAVEL_TYPES_JSON, [
    'umrah', 'hajj', 'international_tour', 'domestic_tour', 'corporate_travel',
    'business_visit', 'educational_tour', 'vip_travel', 'custom_travel'
  ]),

  // Section 4 — the doc's 11-step lifecycle plus its 6 named exceptions
  // (Delayed, Cancelled, Emergency, Medical Assistance, Lost Traveler,
  // Missed Flight). TravelPlanModel.status enum must be kept in sync with
  // this list.
  travelStatuses: parseStringList(process.env.TRAVEL_STATUSES_JSON, [
    'planning', 'ready', 'departure_scheduled', 'checked_in', 'in_transit',
    'arrived', 'hotel_checked_in', 'tour_active', 'tour_completed', 'return_journey',
    'completed', 'archived',
    'delayed', 'cancelled', 'emergency', 'medical_assistance', 'lost_traveler', 'missed_flight'
  ]),

  // Section 8 of the doc. Not yet wired into any permission check (the
  // module's real permission strings are travel.read/travel.write/admin,
  // matching Booking's coarse-grained convention) — kept here so a future
  // Workflow Part can reference these as `approvalRole` values without
  // introducing a second, undocumented role vocabulary.
  travelRoles: parseStringList(process.env.TRAVEL_ROLES_JSON, [
    'operations_manager', 'travel_coordinator', 'tour_guide', 'driver',
    'hotel_coordinator', 'airport_coordinator', 'visa_officer', 'finance_officer',
    'branch_manager', 'administrator'
  ]),

  // Section 4: "Travel workflow is configurable." Part 1 doesn't publish an
  // authoritative transition table the way Booking Part 5 eventually did —
  // this is a first-pass default modeling the doc's own lifecycle diagram
  // faithfully (main path + named exceptions + a generic recovery + cancel
  // from any active state), expected to be superseded if/when a dedicated
  // Travel Workflow Part arrives, exactly like bookingConfig.workflowTransitions
  // was wholesale replaced once Booking's own Workflow Part was pasted.
  workflowTransitions: parseJson(process.env.TRAVEL_WORKFLOW_DEFINITIONS_JSON, [
    // Main lifecycle path (Section 4 diagram)
    { fromState: 'planning', action: 'Mark Ready', toState: 'ready' },
    { fromState: 'ready', action: 'Schedule Departure', toState: 'departure_scheduled' },
    { fromState: 'departure_scheduled', action: 'Check In', toState: 'checked_in' },
    { fromState: 'checked_in', action: 'Depart', toState: 'in_transit' },
    { fromState: 'in_transit', action: 'Arrive', toState: 'arrived' },
    { fromState: 'arrived', action: 'Check Into Hotel', toState: 'hotel_checked_in' },
    { fromState: 'hotel_checked_in', action: 'Start Tour', toState: 'tour_active' },
    { fromState: 'tour_active', action: 'Complete Tour', toState: 'tour_completed' },
    { fromState: 'tour_completed', action: 'Begin Return Journey', toState: 'return_journey' },
    { fromState: 'return_journey', action: 'Complete Trip', toState: 'completed' },
    { fromState: 'completed', action: 'Archive Travel Plan', toState: 'archived' },

    // Exception entries — scoped to the states where each exception is
    // realistically reachable, not fanned out to every state.
    { fromState: 'departure_scheduled', action: 'Report Missed Flight', toState: 'missed_flight' },
    { fromState: 'checked_in', action: 'Report Missed Flight', toState: 'missed_flight' },

    { fromState: 'departure_scheduled', action: 'Report Delay', toState: 'delayed' },
    { fromState: 'checked_in', action: 'Report Delay', toState: 'delayed' },
    { fromState: 'in_transit', action: 'Report Delay', toState: 'delayed' },
    { fromState: 'return_journey', action: 'Report Delay', toState: 'delayed' },

    { fromState: 'in_transit', action: 'Report Medical Assistance', toState: 'medical_assistance' },
    { fromState: 'arrived', action: 'Report Medical Assistance', toState: 'medical_assistance' },
    { fromState: 'hotel_checked_in', action: 'Report Medical Assistance', toState: 'medical_assistance' },
    { fromState: 'tour_active', action: 'Report Medical Assistance', toState: 'medical_assistance' },
    { fromState: 'tour_completed', action: 'Report Medical Assistance', toState: 'medical_assistance' },
    { fromState: 'return_journey', action: 'Report Medical Assistance', toState: 'medical_assistance' },

    { fromState: 'arrived', action: 'Report Lost Traveler', toState: 'lost_traveler' },
    { fromState: 'hotel_checked_in', action: 'Report Lost Traveler', toState: 'lost_traveler' },
    { fromState: 'tour_active', action: 'Report Lost Traveler', toState: 'lost_traveler' },
    { fromState: 'tour_completed', action: 'Report Lost Traveler', toState: 'lost_traveler' },

    // "Emergency" is a broad safety valve, reachable from any active
    // pre-completion state.
    { fromState: 'planning', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'ready', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'departure_scheduled', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'checked_in', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'in_transit', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'arrived', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'hotel_checked_in', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'tour_active', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'tour_completed', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'return_journey', action: 'Report Emergency', toState: 'emergency' },

    // Generic recovery — one representative resume target per exception
    // state (the engine's static fromState/toState model can't express
    // "return to whichever state you actually came from"; a state-specific
    // resume matrix belongs to a dedicated Travel Workflow Part).
    { fromState: 'delayed', action: 'Resolve Delay', toState: 'in_transit' },
    { fromState: 'emergency', action: 'Resolve Emergency', toState: 'in_transit' },
    { fromState: 'medical_assistance', action: 'Resolve Medical Assistance', toState: 'tour_active' },
    { fromState: 'lost_traveler', action: 'Resolve Lost Traveler', toState: 'tour_active' },
    { fromState: 'missed_flight', action: 'Resolve Missed Flight', toState: 'delayed' },

    // Cancellation — reachable from any active state, gated behind
    // operations-manager approval (mirrors Booking's Cancel Booking
    // approval convention).
    ...[
      'planning', 'ready', 'departure_scheduled', 'checked_in', 'in_transit', 'arrived',
      'hotel_checked_in', 'tour_active', 'tour_completed', 'return_journey',
      'delayed', 'emergency', 'medical_assistance', 'lost_traveler', 'missed_flight'
    ].map((fromState) => ({
      fromState, action: 'Cancel Travel Plan', toState: 'cancelled', approvalRequired: true, approvalRole: 'operations_manager'
    }))
  ]),

  workflowStates: parseJson(process.env.TRAVEL_WORKFLOW_STATES_JSON, [
    { stateId: 'planning', label: 'Planning', description: 'Travel plan created, still being organized' },
    { stateId: 'ready', label: 'Ready', description: 'All planning complete, ready for departure scheduling' },
    { stateId: 'departure_scheduled', label: 'Departure Scheduled', description: 'Departure date/time confirmed' },
    { stateId: 'checked_in', label: 'Checked In', description: 'Travelers checked in for departure' },
    { stateId: 'in_transit', label: 'In Transit', description: 'Traveling to destination' },
    { stateId: 'arrived', label: 'Arrived', description: 'Arrived at destination' },
    { stateId: 'hotel_checked_in', label: 'Hotel Checked In', description: 'Checked into accommodation' },
    { stateId: 'tour_active', label: 'Tour Active', description: 'Tour/itinerary in progress' },
    { stateId: 'tour_completed', label: 'Tour Completed', description: 'Tour/itinerary finished' },
    { stateId: 'return_journey', label: 'Return Journey', description: 'Traveling back' },
    { stateId: 'completed', label: 'Completed', description: 'Trip fully completed' },
    { stateId: 'archived', label: 'Archived', description: 'Archived, read-only' },
    { stateId: 'delayed', label: 'Delayed', description: 'A flight/transport/schedule delay is in progress' },
    { stateId: 'cancelled', label: 'Cancelled', description: 'Travel plan cancelled' },
    { stateId: 'emergency', label: 'Emergency', description: 'Active emergency requiring escalation' },
    { stateId: 'medical_assistance', label: 'Medical Assistance', description: 'A traveler requires medical assistance' },
    { stateId: 'lost_traveler', label: 'Lost Traveler', description: 'A traveler is unaccounted for' },
    { stateId: 'missed_flight', label: 'Missed Flight', description: 'A scheduled flight was missed' }
  ])
});
