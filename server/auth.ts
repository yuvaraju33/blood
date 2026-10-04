import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import session from "express-session";
import express, { type Express, Request, Response, NextFunction, RequestHandler } from "express";
import crypto from "crypto";
import { promisify } from "util";
import connectPg from "connect-pg-simple";
import createMemoryStore from "memorystore";
import multer from "multer";
import path from "path";
import fs from "fs";
import { storage } from "./storage.js";
import { insertUserSchema, type User } from "../shared/schema.js";
import { put } from "@vercel/blob";

// Configure multer for PDF uploads
const uploadDir = "uploads";
if (!process.env.VERCEL && !fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const multerStorage = multer.memoryStorage();

const upload = multer({
    storage: multerStorage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === "application/pdf") {
            cb(null, true);
        } else {
            cb(new Error("Only PDF files are allowed"));
        }
    },
    limits: {
        fileSize: 2 * 1024 * 1024, // 2MB
    },
});

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password: string) {
    const salt = crypto.randomBytes(16).toString("hex");
    const buf = (await scrypt(password, salt, 64)) as Buffer;
    return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(supplied: string, stored: string) {
    const [hashed, salt] = stored.split(".");
    const hashedBuf = Buffer.from(hashed, "hex");
    const suppliedBuf = (await scrypt(supplied, salt, 64)) as Buffer;
    return crypto.timingSafeEqual(hashedBuf, suppliedBuf);
}

const uploadImage = multer({
    storage: multerStorage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/")) {
            cb(null, true);
        } else {
            cb(new Error("Only image files are allowed"));
        }
    },
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
    },
});

async function uploadFile(file: Express.Multer.File): Promise<string> {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
        const blob = await put(`uploads/${Date.now()}-${file.originalname}`, file.buffer, { access: 'public' });
        return blob.url;
    } else {
        if (process.env.VERCEL) {
            throw new Error("Local file uploads are not supported on Vercel. Please configure BLOB_READ_WRITE_TOKEN.");
        }
        const filename = `${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`;
        const filePath = path.join(uploadDir, filename);
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        fs.writeFileSync(filePath, file.buffer);
        return `/uploads/${filename}`;
    }
}

export function setupAuth(app: Express) {
    const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
    let sessionStore: any;

    const MemoryStore = createMemoryStore(session);
    sessionStore = new MemoryStore({
        checkPeriod: 86400000,
    });

    app.use(
        session({
            secret: process.env.SESSION_SECRET || "bloodlink-default-secret",
            resave: false,
            saveUninitialized: false,
            store: sessionStore,
            cookie: {
                secure: process.env.NODE_ENV === "production",
                maxAge: sessionTtl,
            },
        }),
    );

    app.use(passport.initialize());
    app.use(passport.session());

    passport.use(
        new LocalStrategy(async (username, password, done) => {
            try {
                const user = await storage.getUserByUsername(username);
                if (!user || !(await comparePasswords(password, user.password))) {
                    return done(null, false);
                }
                return done(null, user);
            } catch (err) {
                return done(err);
            }
        }),
    );

    passport.serializeUser((user: any, done) => done(null, user.id));
    passport.deserializeUser(async (id: string, done) => {
        try {
            const user = await storage.getUser(id);
            done(null, user);
        } catch (err) {
            done(err);
        }
    });

    app.post("/api/register", upload.single("idDocument"), async (req, res, next) => {
        try {
            let bloodGroup = req.body.bloodGroup;
            if (typeof bloodGroup === 'string') {
                bloodGroup = bloodGroup.trim();
            }
            if (!bloodGroup || bloodGroup === "" || bloodGroup === "null" || bloodGroup === "undefined") {
                bloodGroup = null;
            }

            const data = {
                ...req.body,
                bloodGroup,
                idDocumentUrl: req.file ? await uploadFile(req.file) : null,
            };

            console.log("Input data for Zod:", JSON.stringify(data, null, 2));
            const result = insertUserSchema.safeParse(data);
            if (!result.success) {
                console.log("Zod parsing failed:", JSON.stringify(result.error.issues, null, 2));
                return res.status(400).json(result.error);
            }
            console.log("Data after Zod parsing:", JSON.stringify(result.data, null, 2));

            const existingUser = await storage.getUserByUsername(result.data.username);
            if (existingUser) {
                return res.status(400).send("Username already exists");
            }

            const hashedPassword = await hashPassword(result.data.password);

            const userData = {
                ...result.data,
                password: hashedPassword,
                isVerified: true,
                age: 18,
            };
            console.log("Creating user with data:", JSON.stringify(userData, null, 2));
            const user = await storage.createUser(userData);

            req.login(user, (err) => {
                if (err) return next(err);
                res.status(201).json(user);
            });
        } catch (err) {
            next(err);
        }
    });

    // Profile picture upload endpoint
    app.post("/api/users/me/avatar", isAuthenticated, uploadImage.single("avatar"), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).send("No file uploaded");
            }

            const userId = (req.user as any).id;
            const profileImageUrl = await uploadFile(req.file);

            const user = await storage.updateUser(userId, { profileImageUrl });
            res.json(user);
        } catch (error) {
            console.error("Error uploading avatar:", error);
            res.status(500).send("Failed to upload avatar");
        }
    });

    // Serve static files from uploads directory
    app.use("/uploads", express.static("uploads"));

    app.post("/api/login", (req, res, next) => {
        passport.authenticate("local", (err: any, user: any, info: any) => {
            if (err) return next(err);
            if (!user) return res.status(401).send("Invalid username or password");
            req.login(user, (err) => {
                if (err) return next(err);
                res.status(200).json(user);
            });
        })(req, res, next);
    });

    app.post("/api/logout", (req, res, next) => {
        req.logout((err) => {
            if (err) return next(err);
            req.session.destroy((err) => {
                if (err) return next(err);
                res.clearCookie("connect.sid");
                res.sendStatus(200);
            });
        });
    });

    app.get("/api/auth/user", (req, res) => {
        if (!req.isAuthenticated()) return res.sendStatus(401);
        res.json(req.user);
    });
}

export const isAuthenticated: RequestHandler = (req, res, next) => {
    if (req.isAuthenticated()) {
        return next();
    }
    res.status(401).send("Unauthorized");
};
