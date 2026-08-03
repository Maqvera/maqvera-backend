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

export const getAttendanceConfig = () => ({
  defaultAttendanceStatus: process.env.DEFAULT_ATTENDANCE_STATUS || 'Scheduled',

  // "Attendance Lifecycle" + "Allowed Statuses" (PATCH endpoint) reconciled
  // into one list — "Scheduled" is the honest stub state before a traveler
  // has been evaluated at all (was previously defaulted straight to
  // "Absent", which is a specific, presumptuous outcome, not a neutral
  // starting point). TravelAttendanceModel.status enum must stay in sync.
  attendanceStatuses: parseJson(process.env.ATTENDANCE_STATUSES_JSON, [
    'Scheduled', 'Present', 'Checked In', 'Checked Out', 'Completed',
    'Late', 'Absent', 'Excused', 'Emergency', 'Missing'
  ]),

  // "Verification Methods... Future methods can be added without schema
  // changes" — config-driven so a new method doesn't require a code change,
  // Mongoose enum kept as a redundant DB-level safety net matching this list.
  verificationMethods: parseJson(process.env.ATTENDANCE_VERIFICATION_METHODS_JSON, [
    'Manual', 'QR Code', 'NFC', 'Barcode', 'GPS', 'Biometric', 'Mobile App'
  ]),

  // "Senior Enterprise Improvement: Attendance Rules and Escalation
  // Policies" / Business Rule "Attendance window configurable" / "Late
  // threshold configurable." Was previously hardcoded inline
  // (checkInWindowMinutes:30, lateThresholdMinutes:10, missingThresholdMinutes:20)
  // with zero env override and no way for a caller to override per-session.
  defaultPolicy: parseJson(process.env.ATTENDANCE_DEFAULT_POLICY_JSON, {
    checkInWindowMinutes: 30,
    lateThresholdMinutes: 10,
    missingThresholdMinutes: 20,
    emergencyNotifyImmediate: true,
    autoCloseAfterWindow: true
  }),

  // "Workflow configurable." No authoritative transition table is given in
  // Part 7 (same situation every prior Travel Part was in) — reasonable
  // default covering evaluation-from-scheduled plus common corrections
  // (e.g. staff fixing a mis-marked status).
  workflowTransitions: parseJson(process.env.ATTENDANCE_WORKFLOW_DEFINITIONS_JSON, [
    // Initial evaluation branches from the neutral "Scheduled" stub state.
    { fromState: 'scheduled', action: 'Mark Present', toState: 'present' },
    { fromState: 'scheduled', action: 'Check In', toState: 'checked_in' },
    { fromState: 'scheduled', action: 'Mark Late', toState: 'late' },
    { fromState: 'scheduled', action: 'Mark Absent', toState: 'absent' },
    { fromState: 'scheduled', action: 'Mark Excused', toState: 'excused' },
    { fromState: 'scheduled', action: 'Mark Missing', toState: 'missing' },
    { fromState: 'scheduled', action: 'Report Emergency', toState: 'emergency' },

    // Progression
    { fromState: 'present', action: 'Check Out', toState: 'checked_out' },
    { fromState: 'checked_in', action: 'Check Out', toState: 'checked_out' },
    { fromState: 'late', action: 'Check In', toState: 'checked_in' },
    { fromState: 'late', action: 'Check Out', toState: 'checked_out' },
    { fromState: 'checked_out', action: 'Complete Attendance', toState: 'completed' },
    { fromState: 'excused', action: 'Complete Attendance', toState: 'completed' },

    // Corrections — staff fixing a mis-marked status, or a missing traveler
    // being found.
    { fromState: 'present', action: 'Mark Late', toState: 'late' },
    { fromState: 'absent', action: 'Check In', toState: 'checked_in' },
    { fromState: 'absent', action: 'Mark Excused', toState: 'excused' },
    { fromState: 'missing', action: 'Check In', toState: 'checked_in' },

    // Emergency — reachable from any active pre-completion state, resolves
    // back into a normal outcome.
    ...['present', 'checked_in', 'late', 'absent', 'missing'].map((fromState) => ({
      fromState, action: 'Report Emergency', toState: 'emergency'
    })),
    { fromState: 'emergency', action: 'Resolve Emergency (Checked In)', toState: 'checked_in' },
    { fromState: 'emergency', action: 'Resolve Emergency (Missing)', toState: 'missing' },
    { fromState: 'emergency', action: 'Complete Attendance', toState: 'completed' }
  ]),

  workflowStates: parseJson(process.env.ATTENDANCE_WORKFLOW_STATES_JSON, [
    { stateId: 'scheduled', label: 'Scheduled', description: 'Not yet evaluated for this activity' },
    { stateId: 'present', label: 'Present', description: 'Traveler is present' },
    { stateId: 'checked_in', label: 'Checked In', description: 'Traveler checked in' },
    { stateId: 'checked_out', label: 'Checked Out', description: 'Traveler checked out' },
    { stateId: 'completed', label: 'Completed', description: 'Attendance record finalized' },
    { stateId: 'late', label: 'Late', description: 'Traveler checked in after the late threshold' },
    { stateId: 'absent', label: 'Absent', description: 'Traveler marked absent' },
    { stateId: 'excused', label: 'Excused', description: 'Traveler absence excused' },
    { stateId: 'emergency', label: 'Emergency', description: 'Active emergency for this traveler' },
    { stateId: 'missing', label: 'Missing', description: 'Traveler unaccounted for' }
  ])
});
