import PassportTrackingModel from "../models/PassportTrackingModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import { PASSPORT_STATUSES, PASSPORT_DOMAIN_EVENTS } from "../utils/visaConstants.js";
import { publishEvent } from "../utils/eventBus.js";
import { v4 as uuidv4 } from "uuid";
import AuditLogModel from "../models/AuditLogmodel.js";
import CourierIntegrationService from "./CourierIntegrationService.js";
import mongoose from "mongoose";

const referenceNumber = (envKey, fallbackPrefix) => `${process.env[`${envKey}_PREFIX`] || fallbackPrefix}-${new Date().getFullYear()}-${uuidv4().slice(0, 8).toUpperCase()}`;

class PassportTrackingEngineService {
  static async getPassportByVisaCaseId(visaCaseId, tenantId) {
    const trackingRecord = await PassportTrackingModel.findOne({ visaCaseId, tenantId });
    if (!trackingRecord) {
      throw new Error("Passport has not been received for this Visa Case.");
    }
    return trackingRecord;
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

    if (mongoose.connection.readyState === 1) await AuditLogModel.create({ tenantId, branchId: passport.branchId, userId: userId || "system", action: "TRANSFER_PASSPORT_CUSTODY", resource: "PassportTracking", resourceId: passport._id.toString(), details: { fromHolder: previousHolder, toHolder, newLocation: passport.currentLocation, targetStatus: passport.currentStatus } }).catch(() => null);

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

    if (mongoose.connection.readyState === 1) await AuditLogModel.create({ tenantId, branchId: passport.branchId, userId: userId || "system", action: "DISPATCH_PASSPORT", resource: "PassportTracking", resourceId: passport._id.toString(), details: { dispatchNumber, courierCompany, trackingNumber: passport.trackingNumber, embassyName } }).catch(() => null);

    publishEvent(PASSPORT_DOMAIN_EVENTS.PASSPORT_DISPATCHED, {
      passportId: passport._id,
      dispatchNumber,
      courierCompany: passport.courierCompany,
      trackingNumber: passport.trackingNumber, visaCaseId: passport.visaCaseId, tenantId, branchId: passport.branchId
    });

    return passport;
  }

  static async receiveFromEmbassy({ passportId, remarks }, tenantId, userId) {
    const passport = await this.getPassportById(passportId, tenantId);

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

    publishEvent(PASSPORT_DOMAIN_EVENTS.PASSPORT_RETURNED, {
      passportId: passport._id,
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

    publishEvent(PASSPORT_DOMAIN_EVENTS.PASSPORT_COLLECTED, {
      passportId: passport._id,
      collectedBy: passport.collectionInfo.collectedBy,
      receiptNumber,
      timestamp: passport.collectionInfo.collectionTime
    });

    return passport;
  }
}

export default PassportTrackingEngineService;
