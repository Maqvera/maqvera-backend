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

export const getHotelConfig = () => ({
  defaultHotelStatus: (process.env.DEFAULT_HOTEL_STATUS || 'planned').toLowerCase(),

  // Hotel Lifecycle diagram + its named exceptions (Delayed Check-in, Room
  // Change, Overbooking, Cancelled, Maintenance Issue, Emergency).
  // TravelHotelAssignmentModel.status enum must be kept in sync with this.
  hotelStatuses: parseStringList(process.env.HOTEL_STATUSES_JSON, [
    'planned', 'reserved', 'confirmed', 'ready', 'checked_in', 'occupied', 'checked_out', 'completed',
    'delayed', 'room_change', 'overbooking', 'cancelled', 'maintenance_issue', 'emergency'
  ]),

  // "Meal Plans" section: "Supported: Room Only, Breakfast, Half Board, Full
  // Board, All Inclusive, Custom. Meal plans configurable." — kept in the
  // doc's own Title-Case wording (matches the existing schema enum's
  // stored values, not lowercased like other config lists here).
  mealPlans: parseJson(process.env.HOTEL_MEAL_PLANS_JSON, [
    'Room Only', 'Breakfast', 'Half Board', 'Full Board', 'All Inclusive', 'Custom'
  ]),

  // "Incident Severity" — mirrors flightConfig's list so it stays
  // env-overridable independently per module.
  incidentSeverities: parseJson(process.env.HOTEL_INCIDENT_SEVERITIES_JSON, ['Low', 'Medium', 'High', 'Critical']),

  // Fallback capacity-by-room-type used only when a room can't be resolved
  // against the real HotelRoomInventoryModel (ad-hoc/uncatalogued rooms) —
  // kept in the inventory model's own Title-Case roomType values.
  roomTypeCapacities: parseJson(process.env.HOTEL_ROOM_TYPE_CAPACITIES_JSON, {
    Single: 1, Double: 2, Twin: 2, Triple: 3, Quad: 4, Suite: 6, 'Family Suite': 6, Custom: 10
  }),

  // "Workflow configurable." No authoritative transition table is given in
  // Part 4 (same situation Flight/Travel Plan were in) — first-pass default
  // modeling the lifecycle diagram faithfully.
  workflowTransitions: parseJson(process.env.HOTEL_WORKFLOW_DEFINITIONS_JSON, [
    // Main lifecycle path
    { fromState: 'planned', action: 'Reserve', toState: 'reserved' },
    { fromState: 'reserved', action: 'Confirm Hotel', toState: 'confirmed' },
    { fromState: 'confirmed', action: 'Mark Ready For Check-in', toState: 'ready' },
    { fromState: 'ready', action: 'Check In', toState: 'checked_in' },
    { fromState: 'checked_in', action: 'Mark Occupied', toState: 'occupied' },
    { fromState: 'occupied', action: 'Check Out', toState: 'checked_out' },
    { fromState: 'checked_out', action: 'Complete Stay', toState: 'completed' },

    // Exceptions — scoped to where they're realistically reachable.
    { fromState: 'ready', action: 'Report Delayed Check-in', toState: 'delayed' },
    { fromState: 'checked_in', action: 'Report Delayed Check-in', toState: 'delayed' },

    { fromState: 'checked_in', action: 'Report Room Change', toState: 'room_change' },
    { fromState: 'occupied', action: 'Report Room Change', toState: 'room_change' },

    { fromState: 'reserved', action: 'Report Overbooking', toState: 'overbooking' },
    { fromState: 'confirmed', action: 'Report Overbooking', toState: 'overbooking' },
    { fromState: 'ready', action: 'Report Overbooking', toState: 'overbooking' },

    { fromState: 'checked_in', action: 'Report Maintenance Issue', toState: 'maintenance_issue' },
    { fromState: 'occupied', action: 'Report Maintenance Issue', toState: 'maintenance_issue' },

    ...['planned', 'reserved', 'confirmed', 'ready', 'checked_in', 'occupied', 'checked_out'].map((fromState) => ({
      fromState, action: 'Report Emergency', toState: 'emergency'
    })),

    // Recovery — one representative resume target per exception state.
    { fromState: 'delayed', action: 'Resolve Delay', toState: 'checked_in' },
    { fromState: 'room_change', action: 'Resolve Room Change', toState: 'occupied' },
    { fromState: 'overbooking', action: 'Resolve Overbooking', toState: 'confirmed' },
    { fromState: 'maintenance_issue', action: 'Resolve Maintenance Issue', toState: 'occupied' },
    { fromState: 'emergency', action: 'Resolve Emergency', toState: 'occupied' },

    // Cancellation — reachable from any pre-completion active state.
    ...[
      'planned', 'reserved', 'confirmed', 'ready', 'checked_in', 'occupied',
      'delayed', 'room_change', 'overbooking', 'maintenance_issue', 'emergency'
    ].map((fromState) => ({ fromState, action: 'Cancel Hotel Stay', toState: 'cancelled' }))
  ]),

  workflowStates: parseJson(process.env.HOTEL_WORKFLOW_STATES_JSON, [
    { stateId: 'planned', label: 'Planned', description: 'Hotel stay planned' },
    { stateId: 'reserved', label: 'Reserved', description: 'Hotel reservation placed' },
    { stateId: 'confirmed', label: 'Confirmed', description: 'Hotel confirmed the reservation' },
    { stateId: 'ready', label: 'Ready For Check-in', description: 'Ready for guest check-in' },
    { stateId: 'checked_in', label: 'Checked In', description: 'Travelers checked in' },
    { stateId: 'occupied', label: 'Occupied', description: 'Rooms currently occupied' },
    { stateId: 'checked_out', label: 'Checked Out', description: 'Travelers checked out' },
    { stateId: 'completed', label: 'Completed', description: 'Hotel stay fully completed' },
    { stateId: 'delayed', label: 'Delayed Check-in', description: 'Check-in delayed' },
    { stateId: 'room_change', label: 'Room Change', description: 'A room change is in progress' },
    { stateId: 'overbooking', label: 'Overbooking', description: 'Hotel overbooking issue' },
    { stateId: 'cancelled', label: 'Cancelled', description: 'Hotel stay cancelled' },
    { stateId: 'maintenance_issue', label: 'Maintenance Issue', description: 'A maintenance issue affects the stay' },
    { stateId: 'emergency', label: 'Emergency', description: 'Active emergency requiring escalation' }
  ])
});
