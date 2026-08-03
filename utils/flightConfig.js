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

export const getFlightConfig = () => ({
  defaultFlightStatus: (process.env.DEFAULT_FLIGHT_STATUS || 'scheduled').toLowerCase(),

  // Flight Lifecycle diagram + its named exceptions (Delayed, Cancelled,
  // Missed Flight, Rescheduled, Diversion, Emergency). TravelFlightAssignmentModel.status
  // enum must be kept in sync with this list.
  flightStatuses: parseStringList(process.env.FLIGHT_STATUSES_JSON, [
    'scheduled', 'confirmed', 'ticket_issued', 'check_in_open', 'checked_in',
    'boarding', 'departed', 'in_flight', 'arrived', 'completed',
    'delayed', 'cancelled', 'missed_flight', 'rescheduled', 'diversion', 'emergency'
  ]),

  // "Flight Delay Management" section's Delay Types list.
  delayTypes: parseStringList(process.env.FLIGHT_DELAY_TYPES_JSON, [
    'weather', 'technical', 'airport_congestion', 'crew', 'security', 'operational', 'other'
  ]),

  // "Flight Incident Reporting" section's Incident Severity list — mirrors
  // the model's own hardcoded enum so it stays env-overridable too.
  incidentSeverities: parseJson(process.env.FLIGHT_INCIDENT_SEVERITIES_JSON, ['Low', 'Medium', 'High', 'Critical']),

  // "Workflow is configurable." No authoritative transition table is given
  // in Part 3 (same situation Travel Plan's own Part 1 was in) — this is a
  // first-pass default modeling the lifecycle diagram faithfully.
  workflowTransitions: parseJson(process.env.FLIGHT_WORKFLOW_DEFINITIONS_JSON, [
    // Main lifecycle path
    { fromState: 'scheduled', action: 'Confirm Flight', toState: 'confirmed' },
    { fromState: 'confirmed', action: 'Issue Ticket', toState: 'ticket_issued' },
    { fromState: 'ticket_issued', action: 'Open Check-in', toState: 'check_in_open' },
    { fromState: 'check_in_open', action: 'Check In', toState: 'checked_in' },
    { fromState: 'checked_in', action: 'Start Boarding', toState: 'boarding' },
    { fromState: 'boarding', action: 'Depart', toState: 'departed' },
    { fromState: 'departed', action: 'Confirm In Flight', toState: 'in_flight' },
    { fromState: 'in_flight', action: 'Arrive', toState: 'arrived' },
    { fromState: 'arrived', action: 'Complete Flight', toState: 'completed' },

    // Exceptions — scoped to where they're realistically reachable.
    { fromState: 'ticket_issued', action: 'Report Delay', toState: 'delayed' },
    { fromState: 'check_in_open', action: 'Report Delay', toState: 'delayed' },
    { fromState: 'checked_in', action: 'Report Delay', toState: 'delayed' },
    { fromState: 'boarding', action: 'Report Delay', toState: 'delayed' },

    { fromState: 'check_in_open', action: 'Report Missed Flight', toState: 'missed_flight' },
    { fromState: 'checked_in', action: 'Report Missed Flight', toState: 'missed_flight' },
    { fromState: 'boarding', action: 'Report Missed Flight', toState: 'missed_flight' },

    { fromState: 'in_flight', action: 'Report Diversion', toState: 'diversion' },

    { fromState: 'scheduled', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'confirmed', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'ticket_issued', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'check_in_open', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'checked_in', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'boarding', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'departed', action: 'Report Emergency', toState: 'emergency' },
    { fromState: 'in_flight', action: 'Report Emergency', toState: 'emergency' },

    // Recovery — one representative resume target per exception state.
    { fromState: 'delayed', action: 'Resolve Delay', toState: 'boarding' },
    { fromState: 'missed_flight', action: 'Rebook Flight', toState: 'rescheduled' },
    { fromState: 'rescheduled', action: 'Confirm Flight', toState: 'confirmed' },
    { fromState: 'diversion', action: 'Resolve Diversion', toState: 'arrived' },
    { fromState: 'emergency', action: 'Resolve Emergency', toState: 'in_flight' },

    // Cancellation — reachable from any pre-departure/in-transit state.
    ...[
      'scheduled', 'confirmed', 'ticket_issued', 'check_in_open', 'checked_in', 'boarding',
      'delayed', 'missed_flight', 'emergency'
    ].map((fromState) => ({ fromState, action: 'Cancel Flight', toState: 'cancelled' }))
  ]),

  workflowStates: parseJson(process.env.FLIGHT_WORKFLOW_STATES_JSON, [
    { stateId: 'scheduled', label: 'Scheduled', description: 'Flight leg scheduled, not yet confirmed' },
    { stateId: 'confirmed', label: 'Confirmed', description: 'Flight confirmed with the airline' },
    { stateId: 'ticket_issued', label: 'Ticket Issued', description: 'Ticket issued for this flight leg' },
    { stateId: 'check_in_open', label: 'Check-in Open', description: 'Airport check-in window open' },
    { stateId: 'checked_in', label: 'Checked In', description: 'Travelers checked in' },
    { stateId: 'boarding', label: 'Boarding', description: 'Boarding in progress' },
    { stateId: 'departed', label: 'Departed', description: 'Flight has departed' },
    { stateId: 'in_flight', label: 'In Flight', description: 'Flight currently airborne' },
    { stateId: 'arrived', label: 'Arrived', description: 'Flight has landed' },
    { stateId: 'completed', label: 'Completed', description: 'Flight leg fully completed' },
    { stateId: 'delayed', label: 'Delayed', description: 'Flight delayed' },
    { stateId: 'cancelled', label: 'Cancelled', description: 'Flight cancelled' },
    { stateId: 'missed_flight', label: 'Missed Flight', description: 'One or more travelers missed the flight' },
    { stateId: 'rescheduled', label: 'Rescheduled', description: 'Flight rebooked to a new schedule' },
    { stateId: 'diversion', label: 'Diversion', description: 'Flight diverted from its planned route' },
    { stateId: 'emergency', label: 'Emergency', description: 'Active emergency requiring escalation' }
  ])
});
