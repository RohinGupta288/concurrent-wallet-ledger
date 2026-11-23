const mongoose = require("mongoose")
const bcrypt = require("bcryptjs")
const { config } = require("../config/env")

const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: [ true, "Email is required for creating a user" ],
        trim: true,
        lowercase: true,
        maxlength: 254,
        match: [ /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Invalid Email address" ],
        // Database-enforced: two users can never share an email, even if two
        // registrations arrive at the same instant.
        unique: true,
    },
    name: {
        type: String,
        required: [ true, "Name is required for creating an account" ],
        trim: true,
        maxlength: 100,
    },
    password: {
        type: String,
        required: [ true, "Password is required for creating an account" ],
        // Never returned by queries unless explicitly requested with .select("+password").
        select: false,
    },
}, {
    timestamps: true,
})

// Hash the password whenever it is set or changed. Only the bcrypt hash is stored.
userSchema.pre("save", async function () {
    if (!this.isModified("password")) {
        return
    }
    this.password = await bcrypt.hash(this.password, config.bcryptSaltRounds)
})

const userModel = mongoose.model("user", userSchema)

module.exports = userModel
