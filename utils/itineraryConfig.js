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

export const getItineraryConfig = () => ({
  defaultActivityStatus: (process.env.DEFAULT_ACTIVITY_STATUS || 'planned').toLowerCase(),
  // "Supports timezone conversion" / AI Coding Rule "Timezone Aware." Used
  // whenever an activity's request doesn't specify its own timezone.
  defaultTimezone: process.env.DEFAULT_ITINERARY_TIMEZONE || 'Asia/Riyadh',
  defaultActivityDurationMinutes: parseInt(process.env.DEFAULT_ACTIVITY_DURATION_MINUTES || '60', 10),

  // "Activity Types" section: "Types configurable."
  activityTypes: parseJson(process.env.ITINERARY_ACTIVITY_TYPES_JSON, [
    'Airport', 'Flight', 'Hotel', 'Transport', 'Meal', 'Prayer', 'Ziyarat',
    'Shopping', 'Meeting', 'Rest', 'Medical', 'Custom'
  ]),

  // Itinerary Lifecycle diagram + its named exceptions (Delayed, Cancelled,
  // Skipped, Rescheduled, Emergency). TravelItineraryModel.status enum must
  // be kept in sync with this list.
  activityStatuses: parseStringList(process.env.ITINERARY_ACTIVITY_STATUSES_JSON, [
    'draft', 'planned', 'published', 'in_progress', 'completed',
    'delayed', 'cancelled', 'skipped', 'rescheduled', 'emergency'
  ]),

  // "Workflow configurable." No authoritative transition table is given in
  // Part 6 (same situation Flight/Hotel/Transport were in) — first-pass
  // default modeling the lifecycle diagram faithfully.
  workflowTransitions: parseJson(process.env.ITINERARY_WORKFLOW_DEFINITIONS_JSON, [
    // Main lifecycle path
    { fromState: 'draft', action: 'Mark Planned', toState: 'planned' },
    { fromState: 'planned', action: 'Publish Activity', toState: 'published' },
    { fromState: 'published', action: 'Start Activity', toState: 'in_progress' },
    { fromState: 'in_progress', action: 'Complete Activity', toState: 'completed' },

    // Exceptions — scoped to where they're realistically reachable.
    { fromState: 'published', action: 'Report Delay', toState: 'delayed' },
    { fromState: 'in_progress', action: 'Report Delay', toState: 'delayed' },

    { fromState: 'draft', action: 'Skip Activity', toState: 'skipped' },
    { fromState: 'planned', action: 'Skip Activity', toState: 'skipped' },
    { fromState: 'published', action: 'Skip Activity', toState: 'skipped' },

    { fromState: 'planned', action: 'Reschedule Activity', toState: 'rescheduled' },
    { fromState: 'published', action: 'Reschedule Activity', toState: 'rescheduled' },
    { fromState: 'delayed', action: 'Reschedule Activity', toState: 'rescheduled' },

    ...['draft', 'planned', 'published', 'in_progress'].map((fromState) => ({
      fromState, action: 'Report Emergency', toState: 'emergency'
    })),

    // Recovery — one representative resume target per exception state.
    { fromState: 'delayed', action: 'Resolve Delay', toState: 'in_progress' },
    { fromState: 'rescheduled', action: 'Confirm Reschedule', toState: 'planned' },
    { fromState: 'emergency', action: 'Resolve Emergency', toState: 'in_progress' },

    // Cancellation — reachable from any pre-completion active state.
    ...['draft', 'planned', 'published', 'in_progress', 'delayed', 'rescheduled', 'emergency'].map((fromState) => ({
      fromState, action: 'Cancel Activity', toState: 'cancelled'
    }))
  ]),

  workflowStates: parseJson(process.env.ITINERARY_WORKFLOW_STATES_JSON, [
    { stateId: 'draft', label: 'Draft', description: 'Activity drafted, not yet finalized' },
    { stateId: 'planned', label: 'Planned', description: 'Activity planned' },
    { stateId: 'published', label: 'Published', description: 'Activity published to travelers/guides' },
    { stateId: 'in_progress', label: 'In Progress', description: 'Activity currently happening' },
    { stateId: 'completed', label: 'Completed', description: 'Activity fully completed' },
    { stateId: 'delayed', label: 'Delayed', description: 'Activity delayed' },
    { stateId: 'cancelled', label: 'Cancelled', description: 'Activity cancelled' },
    { stateId: 'skipped', label: 'Skipped', description: 'Activity skipped' },
    { stateId: 'rescheduled', label: 'Rescheduled', description: 'Activity rescheduled to a new time' },
    { stateId: 'emergency', label: 'Emergency', description: 'Active emergency requiring escalation' }
  ])
});
