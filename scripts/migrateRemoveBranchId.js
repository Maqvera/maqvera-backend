import dotenv from "dotenv";
import mongoose from "mongoose";

import AIABTestModel from "../models/AIABTestModel.js";
import AIAlertModel from "../models/AIAlertModel.js";
import AIApprovalRequestModel from "../models/AIApprovalRequestModel.js";
import AIConversationModel from "../models/AIConversationModel.js";
import AIGuardrailAuditModel from "../models/AIGuardrailAuditModel.js";
import AIKnowledgeChunkModel from "../models/AIKnowledgeChunkModel.js";
import AIKnowledgeDocumentModel from "../models/AIKnowledgeDocumentModel.js";
import AIPolicyModel from "../models/AIPolicyModel.js";
import AIPromptModel from "../models/AIPromptModel.js";
import AIRequestMetricModel from "../models/AIRequestMetricModel.js";
import AIRoutingPolicyModel from "../models/AIRoutingPolicyModel.js";
import AIShadowTestResultModel from "../models/AIShadowTestResultModel.js";
import AIToolExecutionModel from "../models/AIToolExecutionModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import CustomerModel from "../models/CustomerModel.js";
import CustomerNoteModel from "../models/CustomerNoteModel.js";
import CustomerStatisticsSummaryModel from "../models/CustomerStatisticsSummaryModel.js";
import DepartmentModel from "../models/Departmentmodel.js";
import DomainEventModel from "../models/DomainEventModel.js";
import EmbassyBatchModel from "../models/EmbassyBatchModel.js";
import EmbassySubmissionModel from "../models/EmbassySubmissionModel.js";
import EmployeeProfileModel from "../models/EmployeeProfilemodel.js";
import EmploymentHistoryModel from "../models/EmploymentHistorymodel.js";
import EnterpriseDocumentModel from "../models/EnterpriseDocumentModel.js";
import EnterpriseVerificationModel from "../models/EnterpriseVerificationModel.js";
import FlightBookingModel from "../models/FlightBookingModel.js";
import HotelBookingModel from "../models/HotelBookingModel.js";
import LoginHistoryModel from "../models/LoginHistoryModel.js";
import PassportTrackingModel from "../models/PassportTrackingModel.js";
import SearchIndexModel from "../models/SearchIndexModel.js";
import SessionModel from "../models/Sessionmodel.js";
import TravelAttendanceModel from "../models/TravelAttendanceModel.js";
import TravelAttendanceSessionModel from "../models/TravelAttendanceSessionModel.js";
import TravelFlightAssignmentModel from "../models/TravelFlightAssignmentModel.js";
import TravelHotelAssignmentModel from "../models/TravelHotelAssignmentModel.js";
import TravelIncidentManagementModel from "../models/TravelIncidentManagementModel.js";
import TravelItineraryModel from "../models/TravelItineraryModel.js";
import TravelOperationsSummaryModel from "../models/TravelOperationsSummaryModel.js";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import TravelTransportAssignmentModel from "../models/TravelTransportAssignmentModel.js";
import UnifiedActivityStreamModel from "../models/UnifiedActivityStreamModel.js";
import UserModel from "../models/Usermodel.js";
import VisaAnalyticsSummaryModel from "../models/VisaAnalyticsSummaryModel.js";
import VisaAppointmentModel from "../models/VisaAppointmentModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import VisaCustomerAnalyticsSummaryModel from "../models/VisaCustomerAnalyticsSummaryModel.js";

dotenv.config();

// One-time cleanup migration for the "Fully Remove the Branch Model" change:
// `branchId` was dropped from every schema below (models/Branchmodel.js and
// the Branch concept itself no longer exist — see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
// Mongoose already ignores the field on every read/write going forward, so
// this migration is purely cosmetic/storage-hygiene: it $unsets the now-dead
// `branchId` key from any pre-existing document that still physically
// carries it. It never deletes a document, never touches any other field,
// and is safe to re-run (idempotent — a second run finds nothing left to
// unset). Run manually once per environment, only after this deploy has
// shipped and only once reviewed: `npm run migrate:remove-branch-id`.
const MODELS = [
  AIABTestModel, AIAlertModel, AIApprovalRequestModel, AIConversationModel,
  AIGuardrailAuditModel, AIKnowledgeChunkModel, AIKnowledgeDocumentModel,
  AIPolicyModel, AIPromptModel, AIRequestMetricModel, AIRoutingPolicyModel,
  AIShadowTestResultModel, AIToolExecutionModel, AuditLogModel,
  BookingHeaderModel, CustomerModel, CustomerNoteModel,
  CustomerStatisticsSummaryModel, DepartmentModel, DomainEventModel,
  EmbassyBatchModel, EmbassySubmissionModel, EmployeeProfileModel,
  EmploymentHistoryModel, EnterpriseDocumentModel, EnterpriseVerificationModel,
  FlightBookingModel, HotelBookingModel, LoginHistoryModel,
  PassportTrackingModel, SearchIndexModel, SessionModel, TravelAttendanceModel,
  TravelAttendanceSessionModel, TravelFlightAssignmentModel,
  TravelHotelAssignmentModel, TravelIncidentManagementModel,
  TravelItineraryModel, TravelOperationsSummaryModel, TravelPlanModel,
  TravelTimelineModel, TravelTransportAssignmentModel,
  UnifiedActivityStreamModel, UserModel, VisaAnalyticsSummaryModel,
  VisaAppointmentModel, VisaCaseModel, VisaCustomerAnalyticsSummaryModel,
];

const migrate = async () => {
  const uri = process.env.URI;
  if (!uri) throw new Error("URI is required for migration.");
  await mongoose.connect(uri);

  let totalModified = 0;

  for (const Model of MODELS) {
    const result = await Model.collection.updateMany(
      { branchId: { $exists: true } },
      { $unset: { branchId: "" } }
    );
    if (result.modifiedCount > 0) {
      console.log(`${Model.collection.name}: unset branchId on ${result.modifiedCount} document(s).`);
      totalModified += result.modifiedCount;
    } else {
      console.log(`${Model.collection.name}: no documents carried branchId — nothing to do.`);
    }
  }

  console.log(`Branch-id removal migration complete. ${totalModified} document(s) updated across ${MODELS.length} collection(s).`);
  await mongoose.disconnect();
};

migrate().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
