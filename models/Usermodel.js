import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true
    },
    role: {
        type: String,
        default: "User"
    },
    tenantId: {
        type: String,
        default: null
    },
    status: {
        type: String,
        enum: ["active", "inactive", "suspended", "deleted"],
        default: "active"
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    Isverifed: {
        type: Boolean,
        default: false  
    },
    emailVerified: {
        type: Boolean,
        default: false
    },
    emailVerifiedAt: {
        type: Date,
        default: null
    },
    failedLoginAttempts: {
        type: Number,
        default: 0
    },
    lockUntil: {
        type: Date,
        default: null
    },
    unlockRequestToken: {
        type: String,
        default: null
    },
    unlockRequestExpiresAt: {
        type: Date,
        default: null
    },
    lastLoginAt: {
        type: Date,
        default: null
    },
    passwordChangedAt: {
        type: Date,
        default: null
    },
    mfaEnabled: {
        type: Boolean,
        default: false
    },
    mfaMethod: {
        type: String,
        enum: ["totp", "email", "sms"],
        default: null
    },
    mfaSecretEncrypted: {
        type: String,
        default: null
    },
    mfaSecretIv: {
        type: String,
        default: null
    },
    mfaSecretAuthTag: {
        type: String,
        default: null
    },
    mfaPendingSecretEncrypted: {
        type: String,
        default: null
    },
    mfaPendingSecretIv: {
        type: String,
        default: null
    },
    mfaPendingSecretAuthTag: {
        type: String,
        default: null
    },
    mfaRecoveryCodes: [{
        hash: {
            type: String,
            required: true
        },
        usedAt: {
            type: Date,
            default: null
        }
    }],
    mfaPendingRecoveryCodes: [{
        hash: {
            type: String,
            required: true
        }
    }],
    mfaSetupChallenge: {
        codeHash: {
            type: String,
            default: null
        },
        expiresAt: {
            type: Date,
            default: null
        },
        method: {
            type: String,
            enum: ["email", "sms"],
            default: null
        }
    },
    mfaLoginChallenge: {
        codeHash: {
            type: String,
            default: null
        },
        expiresAt: {
            type: Date,
            default: null
        },
        attempts: {
            type: Number,
            default: 0
        },
        method: {
            type: String,
            enum: ["totp", "email", "sms"],
            default: null
        }
    },
    mfaDisableChallenge: {
        codeHash: {
            type: String,
            default: null
        },
        expiresAt: {
            type: Date,
            default: null
        },
        method: {
            type: String,
            enum: ["email", "sms"],
            default: null
        }
    },
    mfaLastVerifiedAt: {
        type: Date,
        default: null
    },
    mfaRequired: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

const UserModel = mongoose.model("user", UserSchema);

export default UserModel;