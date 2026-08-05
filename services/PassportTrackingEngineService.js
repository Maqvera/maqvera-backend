import PassportTrackingModel from "../models/PassportTrackingModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import { PASSPORT_STATUSES, PASSPORT_DOMAIN_EVENTS } from "../utils/visaConstants.js";
import { publishEvent } from "../utils/eventBus.js";
import { v4 as uuidv4 } from "uuid";
import AuditLogModel from "../models/AuditLogmodel.js";
import CourierIntegrationService from "./CourierIntegrationService.js";
import VisaWorkflowService from "./VisaWorkflowService.js";
import EnterpriseIncidentEngineService from "./EnterpriseIncidentEngineService.js";
import mongoose from "mongoose";

const referenceNumber = (envKey, fallbackPrefix) => `${process.env[`${envKey}_PREFIX`] || fallbackPrefix}-${new Date().getFullYear()}-${uuidv4().slice(0, 8).toUpperCase()}`;

class PassportTrackingEngineService {
  static async getPassportByVisaCaseId(visaCaseId, tenantId, branchId) {
    // Security Rule "Branch Isolation" — was never filtered by branch.
    const filter = { visaCaseId, tenantId };
    if (branchId) filter.branchId = branchId;
    const trackingRecord = await PassportTrackingModel.findOne(filter);
    if (!trackingRecord) {
      throw new Error("Passport has not been received for this Visa Case.");
    }
    // "Latest Event" — named in Response Includes as its own field, not
    // just something the client derives from the tail of trackingEvents.
    const recordObj = trackingRecord.toObject();
    return {
      ...recordObj,
      latestEvent: recordObj.trackingEvents.length > 0 ? recordObj.trackingEvents[recordObj.trackingEvents.length - 1] : null
    };
  }

  static async getPassportById(passportId, tenantId) {
    const passport = await PassportTrackingModel.findOne({ _id: passportId, tenantId });
    if (!passport) {
      throw new Error(`Passport tracking record with ID ${passportId} not found.`);
    }
    return passport;
  }

  static async initializePassportFromVisaCase(visaCase, tenantId) {
    const traveler = visaCase.travelerSnapshot || {};
    const passportRecord = await PassportTrackingModel.create({
      tenantId,
      branchId: visaCase.branchId || "main",
      visaCaseId: visaCase._id,
      travelerId: visaCase.travelerId,
      passportNumber: traveler.passportNumber,
      nationality: traveler.nationality,
      issueDate: traveler.passportIssueDate || null,
      expiryDate: traveler.passportExpiry || null,
      currentStatus: PASSPORT_STATUSES.RECEIVED,
      currentHolder: "Front Desk",
      currentLocation: "Branch Office",
      trackingEvents: [{
        eventId: `EVT-${uuidv4().substring(0, 8)}`,
        eventType: PASSPORT_DOMAIN_EVENTS.PASSPORT_RECEIVED,
        timestamp: new Date(),
        previousHolder: "Traveler",
        newHolder: "Front Desk",
        previousLocation: "Traveler",
        newLocation: "Branch Office",
        performedBy: "System",
        remarks: "Passport auto-initialized from Visa Case."
      }]
    });
    return passportRecord;
  }

  static async receivePassport({ visaCaseId, receivedBy, receivedDate, remarks, location = "Branch Office" }, tenantId, branchId, userId) {
    const visaCase = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId, branchId, isSoftDeleted: { $ne: true } });
    if (!visaCase) {
      throw new Error(`Visa Case with ID ${visaCaseId} not found.`);
    }

    let passport = await PassportTrackingModel.findOne({ visaCaseId, tenantId, branchId: visaCase.branchId });
    const traveler = visaCase.travelerSnapshot || {};
    if (!traveler.passportNumber || !traveler.nationality) throw new Error("Traveler passport number and nationality are required before receipt.");
    if (passport && passport.trackingEvents.some((event) => event.eventType === PASSPORT_DOMAIN_EVENTS.PASSPORT_RECEIVED)) throw new Error("Passport has already been received for this Visa Case.");

    if (!passport) {
      passport = new PassportTrackingModel({
        tenantId,
        branchId: branchId || visaCase.branchId || "main",
        visaCaseId: visaCase._id,
        travelerId: visaCase.travelerId,
        passportNumber: traveler.passportNumber,
        nationality: traveler.nationality,
        issueDate: traveler.passportIssueDate || null,
        expiryDate: traveler.passportExpiry || null,
        currentStatus: PASSPORT_STATUSES.RECEIVED,
        currentHolder: receivedBy || userId || "Front Desk",
        currentLocation: location,
        trackingEvents: []
      });
    }

    const eventId = `EVT-${uuidv4().substring(0, 8)}`;
    const event = {
      eventId,
      eventType: PASSPORT_DOMAIN_EVENTS.PASSPORT_RECEIVED,
      timestamp: receivedDate ? new Date(receivedDate) : new Date(),
      previousHolder: "Traveler",
      newHolder: receivedBy || userId || "Front Desk",
      previousLocation: "Traveler",
      newLocation: location,
      performedBy: userId || "Staff",
      remarks: remarks || "Original passport physical copy received from traveler."
    };

    passport.currentStatus = PASSPORT_STATUSES.RECEIVED;
    passport.currentHolder = receivedBy || userId || "Front Desk";
    passport.currentLocation = location;
    passport.trackingEvents.push(event);

    await passport.save();

    // "Create Timeline" — every write method in this service was missing
    // this; the Visa Case's own timeline never reflected any passport
    // movement at all, unlike every other domain (documents, embassy,
    // appointments, workflow).
    visaCase.timeline.push({
      event: "PassportReceived",
      description: `Passport ${passport.passportNumber} received from traveler by ${passport.currentHolder}.`,
      performedBy: userId || "system",
      timestamp: event.timestamp
    });
    await visaCase.save();

    if (mongoose.connection.readyState === 1) await AuditLogModel.create({ tenantId, branchId: passport.branchId, userId: userId || "system", action: "RECEIVE_PASSPORT", resource: "PassportTracking", resourceId: passport._id.toString(), details: { visaCaseId, receivedBy, receivedDate } }).catch(() => null);

    publishEvent(PASSPORT_DOMAIN_EVENTS.PASSPORT_RECEIVED, {
      passportId: passport._id,
      visaCaseId,
      passportNumber: passport.passportNumber,
      receivedBy: passport.currentHolder,
      timestamp: event.timestamp, tenantId, branchId: passport.branchId
    });

    return passport;
  }

  static async transferCustody({ passportId, fromHolder, toHolder, newLocation, targetStatus, handoverTime, remarks }, tenantId, userId) {
    const passport = await this.getPassportById(passportId, tenantId);

    const eventId = `EVT-${uuidv4().substring(0, 8)}`;
    const previousHolder = passport.currentHolder;
    const previousLocation = passport.currentLocation;

    if (!toHolder) throw new Error("toHolder is required for custody transfer.");
    if (fromHolder && fromHolder !== previousHolder) throw new Error("Transfer sender does not match current passport holder.");
    passport.currentHolder = toHolder;
    passport.currentLocation = newLocation || previousLocation;
    passport.currentStatus = targetStatus || passport.currentStatus;

    const event = {
      eventId,
      eventType: PASSPORT_DOMAIN_EVENTS.PASSPORT_TRANSFERRED,
      timestamp: handoverTime ? new Date(handoverTime) : new Date(),
      previousHolder,
      newHolder: passport.currentHolder,
      previousLocation,
      newLocation: passport.currentLocation,
      performedBy: userId || "Staff",
      reason: "Internal Chain of Custody Transfer",
      remarks: remarks || `Passport custody transferred from ${previousHolder} to ${passport.currentHolder}`
    };

    passport.trackingEvents.push(event);
    await passport.save();

    if (mongoose.connection.readyState === 1) {
      const visaCase = await VisaCaseModel.findOne({ _id: passport.visaCaseId, tenantId });
      if (visaCase) {
        visaCase.timeline.push({
          event: "PassportTransferred",
          description: `Passport ${passport.passportNumber} custody transferred from ${previousHolder} to ${passport.currentHolder}.`,
          performedBy: userId || "system",
          timestamp: event.timestamp
        });
        await visaCase.save();
      }
    }

    if (mongoose.connection.readyState === 1) await AuditLogModel.create({ tenantId, branchId: passport.branchId, userId: userId || "system", action: "TRANSFER_PASSPORT_CUSTODY", resource: "PassportTracking", resourceId: passport._id.toString(), details: { fromHolder: previousHolder, toHolder, newLocation: passport.currentLocation, targetStatus: passport.currentStatus } }).catch(() => null);

    // PassportCustodyChanged is the generic signal; PassportTransferred
    // (the event named for THIS specific endpoint's own "Publish
    // PassportTransferred" workflow step) was only ever used as a tracking
    // event label, never actually published on the real event bus.
    publishEvent(PASSPORT_DOMAIN_EVENTS.PASSPORT_TRANSFERRED, {
      passportId: passport._id,
      previousHolder,
      newHolder: passport.currentHolder,
      performedBy: userId, visaCaseId: passport.visaCaseId, tenantId, branchId: passport.branchId
    });
    publishEvent(PASSPORT_DOMAIN_EVENTS.PASSPORT_CUSTODY_CHANGED, {
      passportId: passport._id,
      previousHolder,
      newHolder: passport.currentHolder,
      performedBy: userId, visaCaseId: passport.visaCaseId, tenantId, branchId: passport.branchId
    });

    return passport;
  }

  static async dispatchToEmbassy({ passportId, courierCompany, trackingNumber, expectedDelivery, remarks, embassyName }, tenantId, userId) {
    const passport = await this.getPassportById(passportId, tenantId);
    if (!courierCompany || !expectedDelivery) throw new Error("courierCompany and expectedDelivery are required for dispatch.");
    if (![PASSPORT_STATUSES.READY_FOR_DISPATCH, PASSPORT_STATUSES.RECEIVED].includes(passport.currentStatus)) throw new Error("Passport is not ready for dispatch.");

    const dispatchNumber = referenceNumber("PASSPORT_DISPATCH", "DISP");
    const courierResult = await CourierIntegrationService.createShipment({ dispatchNumber, courierCompany, trackingNumber, expectedDelivery, passportId });

    passport.currentStatus = PASSPORT_STATUSES.DISPATCHED;
    passport.currentHolder = courierCompany;
    passport.currentLocation = "In Transit to Embassy";
    passport.courierCompany = courierCompany;
    passport.embassyName = embassyName || passport.embassyName || null;
    passport.trackingNumber = courierResult.trackingNumber || trackingNumber || null;
    passport.dispatchInfo = {
      dispatchNumber,
      courier: passport.courierCompany,
      trackingNumber: passport.trackingNumber,
      dispatchTime: new Date(),
      expectedDelivery: expectedDelivery ? new Date(expectedDelivery) : new Date(Date.now() + 86400000 * 2)
    };

    const event = {
      eventId: `EVT-${uuidv4().substring(0, 8)}`,
      eventType: PASSPORT_DOMAIN_EVENTS.PASSPORT_DISPATCHED,
      timestamp: new Date(),
      previousHolder: "Branch Operations",
      newHolder: passport.courierCompany,
      previousLocation: "Branch Office",
      newLocation: "In Transit",
      performedBy: userId || "Staff",
      remarks: remarks || `Dispatched to embassy via ${passport.courierCompany} with tracking #${passport.trackingNumber}`
    };

    passport.trackingEvents.push(event);
    await passport.save();

    if (mongoose.connection.readyState === 1) {
      const visaCaseForDispatch = await VisaCaseModel.findOne({ _id: passport.visaCaseId, tenantId });
      if (visaCaseForDispatch) {
        visaCaseForDispatch.timeline.push({
          event: "PassportDispatched",
          description: `Passport ${passport.passportNumber} dispatched to embassy via ${passport.courierCompany} (Ref: ${dispatchNumber}).`,
          performedBy: userId || "system",
          timestamp: event.timestamp
        });
        await visaCaseForDispatch.save();
      }
    }

    if (mongoose.connection.readyState === 1) await AuditLogModel.create({ tenantId, branchId: passport.branchId, userId: userId || "system", action: "DISPATCH_PASSPORT", resource: "PassportTracking", resourceId: passport._id.toString(), details: { dispatchNumber, courierCompany, trackingNumber: passport.trackingNumber, embassyName } }).catch(() => null);

    publishEvent(PASSPORT_DOMAIN_EVENTS.PASSPORT_DISPATCHED, {
      passportId: passport._id,
      dispatchNumber,
      courierCompany: passport.courierCompany,
      trackingNumber: passport.trackingNumber, visaCaseId: passport.visaCaseId, tenantId, branchId: passport.branchId
    });

    return passport;
  }

  static async receiveFromEmbassy({ passportId, remarks }, tenantId, userId, userRoles = []) {
    const passport = await this.getPassportById(passportId, tenantId);

    // "Validate Dispatch" — was entirely absent; this could previously be
    // called on a passport that was never dispatched (still "Received") or
    // one already collected, silently overwriting its status regardless.
    const dispatchedStates = [PASSPORT_STATUSES.DISPATCHED, PASSPORT_STATUSES.WITH_COURIER, PASSPORT_STATUSES.AT_EMBASSY, PASSPORT_STATUSES.EMBASSY_PROCESSING];
    if (!dispatchedStates.includes(passport.currentStatus)) {
      throw new Error(`Passport must be dispatched to the embassy before it can be received back (current status: '${passport.currentStatus}').`);
    }

    passport.currentStatus = PASSPORT_STATUSES.RETURNED;
    passport.currentHolder = "Branch Operations";
    passport.currentLocation = "Branch Office Vault";

    const event = {
      eventId: `EVT-${uuidv4().substring(0, 8)}`,
      eventType: PASSPORT_DOMAIN_EVENTS.PASSPORT_RETURNED,
      timestamp: new Date(),
      previousHolder: "Embassy / VAC",
      newHolder: "Branch Operations",
      previousLocation: "Embassy VAC",
      newLocation: "Branch Office Vault",
      performedBy: userId || "Staff",
      remarks: remarks || "Passport returned from embassy and received safely at branch."
    };

    passport.trackingEvents.push(event);
    await passport.save();

    // "Update Visa Case" — was entirely absent; the case's own status never
    // advanced when its passport actually came back. Best-effort: if the
    // case isn't currently in a state where "return_passport" is a valid
    // workflow transition (e.g. the embassy decision hasn't been
    // registered yet), this doesn't block the passport-tracking action
    // itself, since that's this endpoint's real purpose.
    if (mongoose.connection.readyState === 1) {
      const visaCase = await VisaCaseModel.findOne({ _id: passport.visaCaseId, tenantId });
      if (visaCase) {
        visaCase.timeline.push({
          event: "PassportReturned",
          description: `Passport ${passport.passportNumber} returned from embassy and received at branch.`,
          performedBy: userId || "system",
          timestamp: event.timestamp
        });
        try {
          await VisaWorkflowService.applyTransition({ visaCase, targetState: "passport_returned", userRoles, performedBy: userId || "system", remarks: "Passport returned from embassy." });
        } catch (workflowErr) {
          console.warn("receiveFromEmbassy: workflow transition to passport_returned skipped:", workflowErr.message);
        }
        await visaCase.save();
      }
    }

    if (mongoose.connection.readyState === 1) await AuditLogModel.create({ tenantId, branchId: passport.branchId, userId: userId || "system", action: "RECEIVE_PASSPORT_FROM_EMBASSY", resource: "PassportTracking", resourceId: passport._id.toString(), details: { visaCaseId: passport.visaCaseId, remarks } }).catch(() => null);

    publishEvent(PASSPORT_DOMAIN_EVENTS.PASSPORT_RETURNED, {
      passportId: passport._id,
      visaCaseId: passport.visaCaseId,
      tenantId,
      branchId: passport.branchId,
      returnedAt: new Date(),
      performedBy: userId
    });

    return passport;
  }

  static async collectPassport({ passportId, collectedBy, identityVerified, remarks }, tenantId, userId) {
    if (!identityVerified) {
      throw new Error("Identity verification is mandatory for passport handover.");
    }

    const passport = await this.getPassportById(passportId, tenantId);
    if (passport.currentStatus === PASSPORT_STATUSES.COLLECTED) {
      throw new Error("Passport has already been collected.");
    }

    const receiptNumber = referenceNumber("PASSPORT_RECEIPT", "RCP");

    passport.currentStatus = PASSPORT_STATUSES.COLLECTED;
    passport.currentHolder = collectedBy || "Traveler";
    passport.currentLocation = "Handed Over to Traveler";
    passport.collectionInfo = {
      collectedBy: collectedBy || "Traveler",
      identityVerified: true,
      verifiedBy: userId || "Branch Officer",
      collectionTime: new Date(),
      receiptNumber,
      remarks: remarks || "Passport handed over after identity verification."
    };

    const event = {
      eventId: `EVT-${uuidv4().substring(0, 8)}`,
      eventType: PASSPORT_DOMAIN_EVENTS.PASSPORT_COLLECTED,
      timestamp: new Date(),
      previousHolder: "Branch Operations",
      newHolder: collectedBy || "Traveler",
      previousLocation: "Branch Office Vault",
      newLocation: "Traveler Possession",
      performedBy: userId || "Staff",
      remarks: remarks || `Passport collected by ${collectedBy}. Receipt #${receiptNumber}`
    };

    passport.trackingEvents.push(event);
    await passport.save();

    // "Timeline created" — this Business Rule was named but nothing pushed
    // to the Visa Case's timeline; "Audit" — no AuditLogModel.create call
    // existed at all, despite this being the single most legally/
    // operationally sensitive action in the passport lifecycle (mandatory
    // identity verification, explicitly irreversible).
    if (mongoose.connection.readyState === 1) {
      const visaCase = await VisaCaseModel.findOne({ _id: passport.visaCaseId, tenantId });
      if (visaCase) {
        visaCase.timeline.push({
          event: "PassportCollected",
          description: `Passport ${passport.passportNumber} collected by ${passport.collectionInfo.collectedBy} after identity verification (Receipt #${receiptNumber}).`,
          performedBy: userId || "system",
          timestamp: passport.collectionInfo.collectionTime
        });
        await visaCase.save();
      }
    }

    if (mongoose.connection.readyState === 1) await AuditLogModel.create({ tenantId, branchId: passport.branchId, userId: userId || "system", action: "COLLECT_PASSPORT", resource: "PassportTracking", resourceId: passport._id.toString(), details: { collectedBy: passport.collectionInfo.collectedBy, verifiedBy: passport.collectionInfo.verifiedBy, receiptNumber } }).catch(() => null);

    publishEvent(PASSPORT_DOMAIN_EVENTS.PASSPORT_COLLECTED, {
      passportId: passport._id,
      visaCaseId: passport.visaCaseId,
      tenantId,
      branchId: passport.branchId,
      collectedBy: passport.collectionInfo.collectedBy,
      receiptNumber,
      timestamp: passport.collectionInfo.collectionTime
    });

    return passport;
  }

  /**
   * Lost Passport Procedure: Create Incident -> Lock Visa Case -> Notify
   * Management -> Generate Timeline -> Investigation -> Resolution. This
   * had zero implementation anywhere — isLost/isDamaged existed as schema
   * fields and PassportLost/PassportDamaged as domain event constants, but
   * no method could ever reach either. Reuses
   * EnterpriseIncidentEngineService.createIncident — the same,
   * already-proven mechanism that auto-locks a Visa Case on a Critical
   * incident — rather than reimplementing case-locking here.
   */
  static async reportLostOrDamagedPassport({ passportId, condition, remarks }, tenantId, branchId, userId) {
    const normalizedCondition = String(condition || "").toLowerCase();
    if (!["lost", "damaged"].includes(normalizedCondition)) {
      throw new Error("condition must be 'lost' or 'damaged'.");
    }

    const passport = await this.getPassportById(passportId, tenantId);
    const isLost = normalizedCondition === "lost";

    passport.currentStatus = isLost ? PASSPORT_STATUSES.LOST : PASSPORT_STATUSES.DAMAGED;
    passport.isLost = isLost;
    passport.isDamaged = !isLost;

    const event = {
      eventId: `EVT-${uuidv4().substring(0, 8)}`,
      eventType: isLost ? PASSPORT_DOMAIN_EVENTS.PASSPORT_LOST : PASSPORT_DOMAIN_EVENTS.PASSPORT_DAMAGED,
      timestamp: new Date(),
      previousHolder: passport.currentHolder,
      newHolder: passport.currentHolder,
      previousLocation: passport.currentLocation,
      newLocation: passport.currentLocation,
      performedBy: userId || "Staff",
      reason: isLost ? "Passport reported lost" : "Passport reported damaged",
      remarks: remarks || `Passport reported ${normalizedCondition}.`
    };
    passport.trackingEvents.push(event);
    await passport.save();

    const visaCase = mongoose.connection.readyState === 1
      ? await VisaCaseModel.findOne({ _id: passport.visaCaseId, tenantId })
      : null;

    // "Create Incident" + "Lock Visa Case" — EnterpriseIncidentEngineService
    // already auto-locks the case on Critical/Emergency severity.
    await EnterpriseIncidentEngineService.createIncident(
      {
        visaCaseId: passport.visaCaseId,
        visaCase,
        title: `Passport ${normalizedCondition === "lost" ? "Lost" : "Damaged"} — ${passport.passportNumber}`,
        description: remarks || `Passport ${passport.passportNumber} reported ${normalizedCondition} while in custody of ${passport.currentHolder}.`,
        category: "Passport",
        severity: "Critical"
      },
      tenantId,
      branchId || passport.branchId,
      userId
    );

    // "Generate Timeline"
    if (visaCase) {
      visaCase.timeline.push({
        event: isLost ? "PassportLost" : "PassportDamaged",
        description: `Passport ${passport.passportNumber} reported ${normalizedCondition}. Case locked pending investigation.`,
        performedBy: userId || "system",
        timestamp: event.timestamp
      });
      await visaCase.save();
    }

    if (mongoose.connection.readyState === 1) await AuditLogModel.create({ tenantId, branchId: passport.branchId, userId: userId || "system", action: isLost ? "REPORT_PASSPORT_LOST" : "REPORT_PASSPORT_DAMAGED", resource: "PassportTracking", resourceId: passport._id.toString(), details: { remarks } }).catch(() => null);

    publishEvent(isLost ? PASSPORT_DOMAIN_EVENTS.PASSPORT_LOST : PASSPORT_DOMAIN_EVENTS.PASSPORT_DAMAGED, {
      passportId: passport._id,
      visaCaseId: passport.visaCaseId,
      tenantId,
      branchId: passport.branchId,
      performedBy: userId
    });

    // "Notify Management" — no real notification provider exists anywhere
    // in this codebase, so this publishes the same NotificationRequested
    // pattern already established elsewhere rather than claiming delivery.
    publishEvent("NotificationRequested", {
      tenantId,
      branchId: passport.branchId,
      event: isLost ? "PassportLost" : "PassportDamaged",
      priority: "immediate",
      visaCaseId: passport.visaCaseId,
      passportNumber: passport.passportNumber
    });

    return passport;
  }
}

export default PassportTrackingEngineService;
