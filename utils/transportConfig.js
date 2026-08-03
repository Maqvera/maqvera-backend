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

export const getTransportConfig = () => ({
  defaultTransportStatus: (process.env.DEFAULT_TRANSPORT_STATUS || 'planned').toLowerCase(),

  // Transport Lifecycle diagram + its named exceptions (Delayed, Vehicle
  // Breakdown, Driver Changed, Route Changed, Traffic Delay, Emergency,
  // Cancelled). TravelTransportAssignmentModel.status enum must be kept in
  // sync with this list.
  transportStatuses: parseStringList(process.env.TRANSPORT_STATUSES_JSON, [
    'planned', 'vehicle_assigned', 'driver_assigned', 'route_confirmed', 'ready',
    'boarding', 'departed', 'in_transit', 'arrived', 'completed',
    'delayed', 'traffic_delay', 'breakdown', 'driver_changed', 'route_changed', 'cancelled', 'emergency'
  ]),

  // "Incident Severity" — mirrors flightConfig/hotelConfig's list.
  incidentSeverities: parseJson(process.env.TRANSPORT_INCIDENT_SEVERITIES_JSON, ['Low', 'Medium', 'High', 'Critical']),

  // "Workflow configurable." No authoritative transition table is given in
  // Part 5 (same situation Flight/Hotel were in) — first-pass default
  // modeling the lifecycle diagram faithfully.
  workflowTransitions: parseJson(process.env.TRANSPORT_WORKFLOW_DEFINITIONS_JSON, [
    // Main lifecycle path
    { fromState: 'planned', action: 'Assign Vehicle', toState: 'vehicle_assigned' },
    { fromState: 'vehicle_assigned', action: 'Assign Driver', toState: 'driver_assigned' },
    { fromState: 'driver_assigned', action: 'Confirm Route', toState: 'route_confirmed' },
    { fromState: 'route_confirmed', action: 'Mark Ready', toState: 'ready' },
    { fromState: 'ready', action: 'Start Boarding', toState: 'boarding' },
    { fromState: 'boarding', action: 'Depart', toState: 'departed' },
    { fromState: 'departed', action: 'Confirm In Transit', toState: 'in_transit' },
    { fromState: 'in_transit', action: 'Arrive', toState: 'arrived' },
    { fromState: 'arrived', action: 'Complete Trip', toState: 'completed' },

    // Exceptions — scoped to where they're realistically reachable.
    { fromState: 'ready', action: 'Report Delay', toState: 'delayed' },
    { fromState: 'boarding', action: 'Report Delay', toState: 'delayed' },
    { fromState: 'departed', action: 'Report Delay', toState: 'delayed' },
    { fromState: 'in_transit', action: 'Report Delay', toState: 'delayed' },

    { fromState: 'departed', action: 'Report Traffic Delay', toState: 'traffic_delay' },
    { fromState: 'in_transit', action: 'Report Traffic Delay', toState: 'traffic_delay' },

    { fromState: 'boarding', action: 'Report Vehicle Breakdown', toState: 'breakdown' },
    { fromState: 'departed', action: 'Report Vehicle Breakdown', toState: 'breakdown' },
    { fromState: 'in_transit', action: 'Report Vehicle Breakdown', toState: 'breakdown' },

    { fromState: 'vehicle_assigned', action: 'Report Driver Changed', toState: 'driver_changed' },
    { fromState: 'driver_assigned', action: 'Report Driver Changed', toState: 'driver_changed' },
    { fromState: 'route_confirmed', action: 'Report Driver Changed', toState: 'driver_changed' },
    { fromState: 'ready', action: 'Report Driver Changed', toState: 'driver_changed' },

    { fromState: 'route_confirmed', action: 'Report Route Changed', toState: 'route_changed' },
    { fromState: 'ready', action: 'Report Route Changed', toState: 'route_changed' },
    { fromState: 'boarding', action: 'Report Route Changed', toState: 'route_changed' },

    ...['planned', 'vehicle_assigned', 'driver_assigned', 'route_confirmed', 'ready', 'boarding', 'departed', 'in_transit'].map((fromState) => ({
      fromState, action: 'Report Emergency', toState: 'emergency'
    })),

    // Recovery — one representative resume target per exception state.
    { fromState: 'delayed', action: 'Resolve Delay', toState: 'departed' },
    { fromState: 'traffic_delay', action: 'Resolve Traffic Delay', toState: 'in_transit' },
    { fromState: 'breakdown', action: 'Resolve Breakdown', toState: 'in_transit' },
    { fromState: 'driver_changed', action: 'Confirm New Driver', toState: 'driver_assigned' },
    { fromState: 'route_changed', action: 'Confirm New Route', toState: 'route_confirmed' },
    { fromState: 'emergency', action: 'Resolve Emergency', toState: 'in_transit' },

    // Cancellation — reachable from any pre-completion active state.
    ...[
      'planned', 'vehicle_assigned', 'driver_assigned', 'route_confirmed', 'ready', 'boarding', 'departed', 'in_transit',
      'delayed', 'traffic_delay', 'breakdown', 'driver_changed', 'route_changed', 'emergency'
    ].map((fromState) => ({ fromState, action: 'Cancel Transport', toState: 'cancelled' }))
  ]),

  workflowStates: parseJson(process.env.TRANSPORT_WORKFLOW_STATES_JSON, [
    { stateId: 'planned', label: 'Planned', description: 'Transport leg planned' },
    { stateId: 'vehicle_assigned', label: 'Vehicle Assigned', description: 'Vehicle assigned to this leg' },
    { stateId: 'driver_assigned', label: 'Driver Assigned', description: 'Driver assigned to this leg' },
    { stateId: 'route_confirmed', label: 'Route Confirmed', description: 'Route confirmed' },
    { stateId: 'ready', label: 'Ready', description: 'Ready for boarding' },
    { stateId: 'boarding', label: 'Boarding', description: 'Boarding in progress' },
    { stateId: 'departed', label: 'Departed', description: 'Vehicle has departed' },
    { stateId: 'in_transit', label: 'In Transit', description: 'Currently en route' },
    { stateId: 'arrived', label: 'Arrived', description: 'Vehicle has arrived' },
    { stateId: 'completed', label: 'Completed', description: 'Transport leg fully completed' },
    { stateId: 'delayed', label: 'Delayed', description: 'Trip delayed' },
    { stateId: 'traffic_delay', label: 'Traffic Delay', description: 'Delay specifically caused by traffic' },
    { stateId: 'breakdown', label: 'Vehicle Breakdown', description: 'Vehicle breakdown in progress' },
    { stateId: 'driver_changed', label: 'Driver Changed', description: 'Driver is being replaced' },
    { stateId: 'route_changed', label: 'Route Changed', description: 'Route is being changed' },
    { stateId: 'cancelled', label: 'Cancelled', description: 'Transport leg cancelled' },
    { stateId: 'emergency', label: 'Emergency', description: 'Active emergency requiring escalation' }
  ])
});
