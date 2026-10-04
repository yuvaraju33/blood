import {
  users,
  bloodRequests,
  hospitalBloodStock,
  type User,
  type UpsertUser,
  type BloodRequest,
  type InsertBloodRequest,
  type HospitalBloodStock,
  type BloodGroup,
  type Announcement,
  type InsertAnnouncement,
  announcements,
} from "../shared/schema.js";
import { db, pool } from "./db.js";
import { eq, and, or, desc, sql, getTableColumns } from "drizzle-orm";
import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: any): Promise<User>;

  // Extended user operations
  updateUser(id: string, data: Partial<UpsertUser>): Promise<User | undefined>;
  getDonors(filters?: { bloodGroup?: string; location?: string; available?: boolean }): Promise<User[]>;
  getAllUsers(): Promise<User[]>;
  createUserByHospital(data: Partial<UpsertUser>): Promise<User>;
  verifyUser(id: string): Promise<User | undefined>;
  deleteUser(id: string): Promise<User | undefined>;
  updateUserStatus(id: string, data: { canDonate?: boolean; availabilityStatus?: boolean }): Promise<User | undefined>;

  // Blood request operations
  createBloodRequest(data: InsertBloodRequest): Promise<BloodRequest>;
  getBloodRequest(id: string): Promise<BloodRequest | undefined>;
  getBloodRequestWithRelations(id: string): Promise<BloodRequest & { requester?: User; matchedDonor?: User } | undefined>;
  getRequestsByUser(userId: string): Promise<BloodRequest[]>;
  getIncomingRequests(userId: string, bloodGroup: BloodGroup): Promise<BloodRequest[]>;
  getCompletedDonations(userId: string): Promise<BloodRequest[]>;
  getRequestsByHospital(hospitalId: string): Promise<BloodRequest[]>;
  updateBloodRequest(id: string, data: Partial<BloodRequest>): Promise<BloodRequest | undefined>;
  acceptRequest(requestId: string, donorId: string): Promise<BloodRequest | undefined>;
  completeRequest(requestId: string): Promise<BloodRequest | undefined>;
  cancelRequest(requestId: string): Promise<BloodRequest | undefined>;
  deleteBloodRequest(id: string): Promise<BloodRequest | undefined>;

  // Hospital blood stock operations
  getHospitalInventory(hospitalId: string): Promise<HospitalBloodStock[]>;
  updateInventory(hospitalId: string, bloodGroup: BloodGroup, delta: number): Promise<HospitalBloodStock>;
  initializeInventory(hospitalId: string): Promise<void>;

  // Announcements
  createAnnouncement(data: InsertAnnouncement): Promise<Announcement>;
  getAnnouncements(userBloodGroup?: string, userId?: string): Promise<(Announcement & { creatorName: string })[]>;

  // Stats
  getStats(): Promise<{
    totalDonors: number;
    availableDonors: number;
    pendingRequests: number;
    completedDonations: number;
    totalHospitals: number;
  }>;

  isDbConnected?(): boolean;
}

export class DatabaseStorage implements IStorage {
  isDbConnected(): boolean {
    return true;
  }

  async getUser(id: string): Promise<User | undefined> {
    if (!db) return undefined;
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    if (!db) return undefined;
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(userData: any): Promise<User> {
    if (!db) throw new Error("Database not connected");
    const [user] = await db
      .insert(users)
      .values(userData)
      .returning();
    return user;
  }

  async updateUser(id: string, data: Partial<UpsertUser>): Promise<User | undefined> {
    if (!db) return undefined;
    const [user] = await db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async getDonors(filters?: { bloodGroup?: string; location?: string; available?: boolean }): Promise<User[]> {
    if (!db) return [];
    const conditions: any[] = [eq(users.role, "user"), eq(users.canDonate, true)];

    if (filters?.bloodGroup && filters.bloodGroup !== "all") {
      conditions.push(eq(users.bloodGroup, filters.bloodGroup as BloodGroup));
    }

    if (filters?.available) {
      conditions.push(eq(users.availabilityStatus, true));
    }

    const result = await db
      .select()
      .from(users)
      .where(and(...conditions))
      .orderBy(desc(users.availabilityStatus), desc(users.donationCount));

    if (filters?.location) {
      return result.filter((u) =>
        u.location?.toLowerCase().includes(filters.location!.toLowerCase())
      );
    }

    return result;
  }

  async getAllUsers(): Promise<User[]> {
    if (!db) return [];
    return db.select().from(users).orderBy(desc(users.createdAt));
  }

  async createUserByHospital(data: Partial<UpsertUser>): Promise<User> {
    if (!db) throw new Error("Database not connected");
    const [user] = await db
      .insert(users)
      .values({
        ...data,
        createdByHospital: true,
        role: "user",
        isVerified: true,
      } as UpsertUser)
      .returning();
    return user;
  }

  async verifyUser(id: string): Promise<User | undefined> {
    if (!db) return undefined;
    const [user] = await db
      .update(users)
      .set({ isVerified: true, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async deleteUser(id: string): Promise<User | undefined> {
    if (!db) return undefined;
    const [user] = await db
      .delete(users)
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async updateUserStatus(id: string, data: { canDonate?: boolean; availabilityStatus?: boolean }): Promise<User | undefined> {
    if (!db) return undefined;
    const [user] = await db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async createBloodRequest(data: InsertBloodRequest): Promise<BloodRequest> {
    if (!db) throw new Error("Database not connected");
    const [request] = await db
      .insert(bloodRequests)
      .values(data)
      .returning();
    return request;
  }

  async getBloodRequest(id: string): Promise<BloodRequest | undefined> {
    if (!db) return undefined;
    const [request] = await db
      .select()
      .from(bloodRequests)
      .where(eq(bloodRequests.id, id));
    return request;
  }

  async getBloodRequestWithRelations(id: string): Promise<BloodRequest & { requester?: User; matchedDonor?: User } | undefined> {
    if (!db) return undefined;
    const [request] = await db
      .select()
      .from(bloodRequests)
      .where(eq(bloodRequests.id, id));

    if (!request) return undefined;

    const requester = request.requestedById
      ? await this.getUser(request.requestedById)
      : undefined;
    const matchedDonor = request.matchedDonorId
      ? await this.getUser(request.matchedDonorId)
      : undefined;

    return { ...request, requester, matchedDonor };
  }

  async getRequestsByUser(userId: string): Promise<BloodRequest[]> {
    if (!db) return [];
    const requests = await db
      .select()
      .from(bloodRequests)
      .where(eq(bloodRequests.requestedById, userId))
      .orderBy(desc(bloodRequests.createdAt));

    const result = [];
    for (const request of requests) {
      const requester = await this.getUser(request.requestedById);
      const matchedDonor = request.matchedDonorId
        ? await this.getUser(request.matchedDonorId)
        : undefined;
      result.push({ ...request, requester, matchedDonor });
    }
    return result;
  }

  async getIncomingRequests(userId: string, bloodGroup: BloodGroup): Promise<BloodRequest[]> {
    if (!db) return [];
    const requests = await db
      .select()
      .from(bloodRequests)
      .where(
        and(
          eq(bloodRequests.bloodGroup, bloodGroup),
          eq(bloodRequests.status, "pending")
        )
      )
      .orderBy(desc(bloodRequests.priority), desc(bloodRequests.createdAt));

    const result = [];
    for (const request of requests) {
      if (request.requestedById === userId) continue;
      const requester = await this.getUser(request.requestedById);
      result.push({ ...request, requester });
    }
    return result;
  }

  async getCompletedDonations(userId: string): Promise<BloodRequest[]> {
    if (!db) return [];
    return db
      .select()
      .from(bloodRequests)
      .where(
        and(
          eq(bloodRequests.matchedDonorId, userId),
          eq(bloodRequests.status, "completed")
        )
      )
      .orderBy(desc(bloodRequests.updatedAt));
  }

  async getRequestsByHospital(hospitalId: string): Promise<BloodRequest[]> {
    if (!db) return [];
    const requests = await db
      .select()
      .from(bloodRequests)
      .where(eq(bloodRequests.hospitalId, hospitalId))
      .orderBy(desc(bloodRequests.priority), desc(bloodRequests.createdAt));

    const result = [];
    for (const request of requests) {
      const requester = await this.getUser(request.requestedById);
      const matchedDonor = request.matchedDonorId
        ? await this.getUser(request.matchedDonorId)
        : undefined;
      result.push({ ...request, requester, matchedDonor });
    }
    return result;
  }

  async updateBloodRequest(id: string, data: Partial<BloodRequest>): Promise<BloodRequest | undefined> {
    if (!db) return undefined;
    const [request] = await db
      .update(bloodRequests)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(bloodRequests.id, id))
      .returning();
    return request;
  }

  async acceptRequest(requestId: string, donorId: string): Promise<BloodRequest | undefined> {
    if (!db) return undefined;
    const [request] = await db
      .update(bloodRequests)
      .set({
        matchedDonorId: donorId,
        status: "accepted",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bloodRequests.id, requestId),
          eq(bloodRequests.status, "pending")
        )
      )
      .returning();
    return request;
  }

  async completeRequest(requestId: string): Promise<BloodRequest | undefined> {
    if (!db) return undefined;
    const request = await this.getBloodRequest(requestId);
    if (!request || request.status !== "accepted") return undefined;

    const [updatedRequest] = await db
      .update(bloodRequests)
      .set({
        status: "completed",
        updatedAt: new Date(),
      })
      .where(eq(bloodRequests.id, requestId))
      .returning();

    if (updatedRequest && request.matchedDonorId) {
      await db
        .update(users)
        .set({
          donationCount: sql`${users.donationCount} + 1`,
          lastDonationDate: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, request.matchedDonorId));
    }

    return updatedRequest;
  }

  async cancelRequest(requestId: string): Promise<BloodRequest | undefined> {
    if (!db) return undefined;
    const [request] = await db
      .update(bloodRequests)
      .set({
        status: "cancelled",
        updatedAt: new Date(),
      })
      .where(eq(bloodRequests.id, requestId))
      .returning();
    return request;
  }

  async deleteBloodRequest(id: string): Promise<BloodRequest | undefined> {
    if (!db) return undefined;
    const [request] = await db
      .delete(bloodRequests)
      .where(eq(bloodRequests.id, id))
      .returning();
    return request;
  }

  async getHospitalInventory(hospitalId: string): Promise<HospitalBloodStock[]> {
    if (!db) return [];
    return db
      .select()
      .from(hospitalBloodStock)
      .where(eq(hospitalBloodStock.hospitalId, hospitalId));
  }

  async updateInventory(hospitalId: string, bloodGroup: BloodGroup, delta: number): Promise<HospitalBloodStock> {
    if (!db) throw new Error("Database not connected");
    const existing = await db
      .select()
      .from(hospitalBloodStock)
      .where(
        and(
          eq(hospitalBloodStock.hospitalId, hospitalId),
          eq(hospitalBloodStock.bloodGroup, bloodGroup)
        )
      );

    if (existing.length > 0) {
      const newUnits = Math.max(0, (existing[0].unitsAvailable || 0) + delta);
      const [updated] = await db
        .update(hospitalBloodStock)
        .set({
          unitsAvailable: newUnits,
          lastUpdated: new Date(),
        })
        .where(eq(hospitalBloodStock.id, existing[0].id))
        .returning();
      return updated;
    } else {
      const [created] = await db
        .insert(hospitalBloodStock)
        .values({
          hospitalId,
          bloodGroup,
          unitsAvailable: Math.max(0, delta),
        })
        .returning();
      return created;
    }
  }

  async initializeInventory(hospitalId: string): Promise<void> {
    if (!db) return;
    const bloodGroups: BloodGroup[] = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"];

    for (const bloodGroup of bloodGroups) {
      const existing = await db
        .select()
        .from(hospitalBloodStock)
        .where(
          and(
            eq(hospitalBloodStock.hospitalId, hospitalId),
            eq(hospitalBloodStock.bloodGroup, bloodGroup)
          )
        );

      if (existing.length === 0) {
        await db.insert(hospitalBloodStock).values({
          hospitalId,
          bloodGroup,
          unitsAvailable: 0,
        });
      }
    }
  }

  async createAnnouncement(data: InsertAnnouncement): Promise<Announcement> {
    if (!db) throw new Error("Database not connected");
    const [announcement] = await db
      .insert(announcements)
      .values(data)
      .returning();
    return announcement;
  }

  async getAnnouncements(userBloodGroup?: string, userId?: string): Promise<(Announcement & { creatorName: string })[]> {
    if (!db) return [];
    const conditions = [];

    if (userId) {
      conditions.push(or(
        eq(announcements.targetUserId, userId),
        and(
          sql`${announcements.targetUserId} IS NULL`,
          or(
            sql`${announcements.targetBloodGroup} IS NULL`,
            eq(announcements.targetBloodGroup, userBloodGroup as BloodGroup)
          )
        )
      ));
    } else {
      conditions.push(sql`${announcements.targetUserId} IS NULL`);
      if (userBloodGroup) {
        conditions.push(or(
          sql`${announcements.targetBloodGroup} IS NULL`,
          eq(announcements.targetBloodGroup, userBloodGroup as BloodGroup)
        ));
      } else {
        conditions.push(sql`${announcements.targetBloodGroup} IS NULL`);
      }
    }

    const results = await db
      .select({
        ...getTableColumns(announcements),
        creatorName: users.name,
      })
      .from(announcements)
      .leftJoin(users, eq(announcements.createdBy, users.id))
      .where(and(...conditions))
      .orderBy(desc(announcements.createdAt));

    return results as (Announcement & { creatorName: string })[];
  }

  async getStats(): Promise<{
    totalDonors: number;
    availableDonors: number;
    pendingRequests: number;
    completedDonations: number;
    totalHospitals: number;
  }> {
    if (!db) {
      return { totalDonors: 0, availableDonors: 0, pendingRequests: 0, completedDonations: 0, totalHospitals: 0 };
    }
    const allUsers = await db
      .select()
      .from(users)
      .where(and(eq(users.role, "user"), eq(users.canDonate, true)));

    const availableUsers = allUsers.filter((u) => u.availabilityStatus);

    const pendingReqs = await db
      .select()
      .from(bloodRequests)
      .where(
        or(
          eq(bloodRequests.status, "pending"),
          eq(bloodRequests.status, "accepted")
        )
      );

    const completedReqs = await db
      .select()
      .from(bloodRequests)
      .where(eq(bloodRequests.status, "completed"));

    const allHospitals = await db
      .select()
      .from(users)
      .where(eq(users.role, "hospital"));

    return {
      totalDonors: allUsers.length,
      availableDonors: availableUsers.length,
      pendingRequests: pendingReqs.length,
      completedDonations: completedReqs.length,
      totalHospitals: allHospitals.length,
    };
  }
}

export class FileStorage implements IStorage {
  private filePath = path.resolve(process.cwd(), "data", "local_db.json");
  private users: Map<string, User> = new Map();
  private bloodRequests: Map<string, BloodRequest> = new Map();
  private hospitalBloodStock: Map<string, HospitalBloodStock> = new Map();
  private announcements: Map<string, Announcement> = new Map();

  constructor() {
    this.init();
  }

  isDbConnected(): boolean {
    return false;
  }

  private init() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        (data.users || []).forEach((u: any) => this.users.set(u.id, this.parseDates(u)));
        (data.bloodRequests || []).forEach((r: any) => this.bloodRequests.set(r.id, this.parseDates(r)));
        (data.hospitalBloodStock || []).forEach((s: any) => this.hospitalBloodStock.set(s.id, this.parseDates(s)));
        (data.announcements || []).forEach((a: any) => this.announcements.set(a.id, this.parseDates(a)));
      } catch (err) {
        console.warn("Failed to load local_db.json, starting fresh", err);
      }
    } else {
      this.seedDefaultData();
      this.save();
    }
  }

  private parseDates(obj: any): any {
    const res = { ...obj };
    for (const key of Object.keys(res)) {
      if (typeof res[key] === "string" && (key.endsWith("At") || key.endsWith("Date") || key === "lastUpdated")) {
        res[key] = new Date(res[key]);
      }
    }
    return res;
  }

  private save() {
    try {
      const data = {
        users: Array.from(this.users.values()),
        bloodRequests: Array.from(this.bloodRequests.values()),
        hospitalBloodStock: Array.from(this.hospitalBloodStock.values()),
        announcements: Array.from(this.announcements.values()),
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save local_db.json:", err);
    }
  }

  private seedDefaultData() {
    // Seed initial demo hospitals and donors for immediate usability
    const cityHospitalId = crypto.randomUUID();
    const cityHospital: User = {
      id: cityHospitalId,
      username: "cityhospital",
      password: "1c29668fe8f731a55639fd5ecbaaeceab519969ca1cfd33d9aa3c4fb0971b3e5cb37715f0eb7ae1f7a1f5928d3ef0c091e2b6a5554ca70830ca0aaefc464c8d5.36fa8ebce441a1a7", // "hospital123"
      email: "contact@cityhospital.org",
      name: "City Care Hospital & Blood Bank",
      role: "hospital",
      phone: "+91 98765 43210",
      location: "Rajanagaram",
      isVerified: true,
      canDonate: false,
      availabilityStatus: false,
      donationCount: 0,
      createdByHospital: false,
      profileImageUrl: null,
      idDocumentUrl: null,
      age: null,
      bloodGroup: null,
      lastDonationDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.set(cityHospitalId, cityHospital);

    const bloodGroups: BloodGroup[] = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"];
    bloodGroups.forEach((bg) => {
      const stockId = crypto.randomUUID();
      this.hospitalBloodStock.set(stockId, {
        id: stockId,
        hospitalId: cityHospitalId,
        bloodGroup: bg,
        unitsAvailable: Math.floor(Math.random() * 8) + 2,
        lastUpdated: new Date(),
      });
    });
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    for (const user of this.users.values()) {
      if (user.username.toLowerCase() === username.toLowerCase()) {
        return user;
      }
    }
    return undefined;
  }

  async createUser(userData: any): Promise<User> {
    const id = userData.id || crypto.randomUUID();
    const now = new Date();
    const user: User = {
      id,
      username: userData.username,
      password: userData.password,
      email: userData.email || null,
      name: userData.name,
      role: userData.role || "user",
      bloodGroup: userData.bloodGroup || null,
      phone: userData.phone || null,
      location: userData.location || null,
      canDonate: userData.canDonate ?? (userData.role === "hospital" ? false : true),
      availabilityStatus: userData.availabilityStatus ?? true,
      donationCount: userData.donationCount || 0,
      createdByHospital: userData.createdByHospital || false,
      isVerified: userData.isVerified ?? (userData.role === "hospital" ? true : false),
      profileImageUrl: userData.profileImageUrl || null,
      idDocumentUrl: userData.idDocumentUrl || null,
      age: userData.age ?? 18,
      lastDonationDate: userData.lastDonationDate ? new Date(userData.lastDonationDate) : null,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(id, user);
    this.save();
    return user;
  }

  async updateUser(id: string, data: Partial<UpsertUser>): Promise<User | undefined> {
    const user = this.users.get(id);
    if (!user) return undefined;

    const updatedUser: User = {
      ...user,
      ...data,
      updatedAt: new Date(),
    } as User;

    this.users.set(id, updatedUser);
    this.save();
    return updatedUser;
  }

  async getDonors(filters?: { bloodGroup?: string; location?: string; available?: boolean }): Promise<User[]> {
    let result = Array.from(this.users.values()).filter(
      (u) => u.role === "user" && u.canDonate === true
    );

    if (filters?.bloodGroup && filters.bloodGroup !== "all") {
      result = result.filter((u) => u.bloodGroup === filters.bloodGroup);
    }

    if (filters?.available) {
      result = result.filter((u) => u.availabilityStatus === true);
    }

    if (filters?.location) {
      const loc = filters.location.toLowerCase();
      result = result.filter((u) => u.location && u.location.toLowerCase().includes(loc));
    }

    result.sort((a, b) => {
      if (a.availabilityStatus !== b.availabilityStatus) {
        return a.availabilityStatus ? -1 : 1;
      }
      return (b.donationCount || 0) - (a.donationCount || 0);
    });

    return result;
  }

  async getAllUsers(): Promise<User[]> {
    return Array.from(this.users.values()).sort(
      (a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0)
    );
  }

  async createUserByHospital(data: Partial<UpsertUser>): Promise<User> {
    return this.createUser({
      ...data,
      createdByHospital: true,
      role: "user",
      isVerified: true,
    });
  }

  async verifyUser(id: string): Promise<User | undefined> {
    return this.updateUser(id, { isVerified: true });
  }

  async deleteUser(id: string): Promise<User | undefined> {
    const user = this.users.get(id);
    if (!user) return undefined;
    this.users.delete(id);
    this.save();
    return user;
  }

  async updateUserStatus(id: string, data: { canDonate?: boolean; availabilityStatus?: boolean }): Promise<User | undefined> {
    return this.updateUser(id, data);
  }

  async createBloodRequest(data: InsertBloodRequest): Promise<BloodRequest> {
    const id = crypto.randomUUID();
    const now = new Date();
    const request: BloodRequest = {
      id,
      requestedById: data.requestedById,
      hospitalId: data.hospitalId || null,
      bloodGroup: data.bloodGroup as BloodGroup,
      location: data.location,
      status: (data.status as any) || "pending",
      priority: (data.priority as any) || "normal",
      unitsNeeded: data.unitsNeeded || 1,
      notes: data.notes || null,
      matchedDonorId: data.matchedDonorId || null,
      createdAt: now,
      updatedAt: now,
    };
    this.bloodRequests.set(id, request);
    this.save();
    return request;
  }

  async getBloodRequest(id: string): Promise<BloodRequest | undefined> {
    return this.bloodRequests.get(id);
  }

  async getBloodRequestWithRelations(id: string): Promise<BloodRequest & { requester?: User; matchedDonor?: User } | undefined> {
    const req = this.bloodRequests.get(id);
    if (!req) return undefined;
    const requester = req.requestedById ? await this.getUser(req.requestedById) : undefined;
    const matchedDonor = req.matchedDonorId ? await this.getUser(req.matchedDonorId) : undefined;
    return { ...req, requester, matchedDonor };
  }

  async getRequestsByUser(userId: string): Promise<BloodRequest[]> {
    const list = Array.from(this.bloodRequests.values())
      .filter((r) => r.requestedById === userId)
      .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));

    const result = [];
    for (const r of list) {
      const requester = await this.getUser(r.requestedById);
      const matchedDonor = r.matchedDonorId ? await this.getUser(r.matchedDonorId) : undefined;
      result.push({ ...r, requester, matchedDonor });
    }
    return result;
  }

  async getIncomingRequests(userId: string, bloodGroup: BloodGroup): Promise<BloodRequest[]> {
    const list = Array.from(this.bloodRequests.values())
      .filter(
        (r) =>
          r.bloodGroup === bloodGroup &&
          r.status === "pending" &&
          r.requestedById !== userId
      )
      .sort((a, b) => {
        if (a.priority === "emergency" && b.priority !== "emergency") return -1;
        if (b.priority === "emergency" && a.priority !== "emergency") return 1;
        return (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0);
      });

    const result = [];
    for (const r of list) {
      const requester = await this.getUser(r.requestedById);
      result.push({ ...r, requester });
    }
    return result;
  }

  async getCompletedDonations(userId: string): Promise<BloodRequest[]> {
    return Array.from(this.bloodRequests.values())
      .filter((r) => r.matchedDonorId === userId && r.status === "completed")
      .sort((a, b) => (b.updatedAt?.getTime() || 0) - (a.updatedAt?.getTime() || 0));
  }

  async getRequestsByHospital(hospitalId: string): Promise<BloodRequest[]> {
    const list = Array.from(this.bloodRequests.values())
      .filter((r) => r.hospitalId === hospitalId)
      .sort((a, b) => {
        if (a.priority === "emergency" && b.priority !== "emergency") return -1;
        if (b.priority === "emergency" && a.priority !== "emergency") return 1;
        return (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0);
      });

    const result = [];
    for (const r of list) {
      const requester = await this.getUser(r.requestedById);
      const matchedDonor = r.matchedDonorId ? await this.getUser(r.matchedDonorId) : undefined;
      result.push({ ...r, requester, matchedDonor });
    }
    return result;
  }

  async updateBloodRequest(id: string, data: Partial<BloodRequest>): Promise<BloodRequest | undefined> {
    const req = this.bloodRequests.get(id);
    if (!req) return undefined;
    const updated: BloodRequest = {
      ...req,
      ...data,
      updatedAt: new Date(),
    };
    this.bloodRequests.set(id, updated);
    this.save();
    return updated;
  }

  async acceptRequest(requestId: string, donorId: string): Promise<BloodRequest | undefined> {
    const req = this.bloodRequests.get(requestId);
    if (!req || req.status !== "pending") return undefined;
    const updated: BloodRequest = {
      ...req,
      matchedDonorId: donorId,
      status: "accepted",
      updatedAt: new Date(),
    };
    this.bloodRequests.set(requestId, updated);
    this.save();
    return updated;
  }

  async completeRequest(requestId: string): Promise<BloodRequest | undefined> {
    const req = this.bloodRequests.get(requestId);
    if (!req || req.status !== "accepted") return undefined;
    const updated: BloodRequest = {
      ...req,
      status: "completed",
      updatedAt: new Date(),
    };
    this.bloodRequests.set(requestId, updated);

    if (req.matchedDonorId) {
      const donor = this.users.get(req.matchedDonorId);
      if (donor) {
        this.users.set(req.matchedDonorId, {
          ...donor,
          donationCount: (donor.donationCount || 0) + 1,
          lastDonationDate: new Date(),
          updatedAt: new Date(),
        });
      }
    }
    this.save();
    return updated;
  }

  async cancelRequest(requestId: string): Promise<BloodRequest | undefined> {
    const req = this.bloodRequests.get(requestId);
    if (!req) return undefined;
    const updated: BloodRequest = {
      ...req,
      status: "cancelled",
      updatedAt: new Date(),
    };
    this.bloodRequests.set(requestId, updated);
    this.save();
    return updated;
  }

  async deleteBloodRequest(id: string): Promise<BloodRequest | undefined> {
    const req = this.bloodRequests.get(id);
    if (!req) return undefined;
    this.bloodRequests.delete(id);
    this.save();
    return req;
  }

  async getHospitalInventory(hospitalId: string): Promise<HospitalBloodStock[]> {
    return Array.from(this.hospitalBloodStock.values()).filter(
      (s) => s.hospitalId === hospitalId
    );
  }

  async updateInventory(hospitalId: string, bloodGroup: BloodGroup, delta: number): Promise<HospitalBloodStock> {
    for (const stock of this.hospitalBloodStock.values()) {
      if (stock.hospitalId === hospitalId && stock.bloodGroup === bloodGroup) {
        const newUnits = Math.max(0, (stock.unitsAvailable || 0) + delta);
        const updated: HospitalBloodStock = {
          ...stock,
          unitsAvailable: newUnits,
          lastUpdated: new Date(),
        };
        this.hospitalBloodStock.set(stock.id, updated);
        this.save();
        return updated;
      }
    }

    const id = crypto.randomUUID();
    const created: HospitalBloodStock = {
      id,
      hospitalId,
      bloodGroup,
      unitsAvailable: Math.max(0, delta),
      lastUpdated: new Date(),
    };
    this.hospitalBloodStock.set(id, created);
    this.save();
    return created;
  }

  async initializeInventory(hospitalId: string): Promise<void> {
    const bloodGroups: BloodGroup[] = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"];
    for (const bg of bloodGroups) {
      const exists = Array.from(this.hospitalBloodStock.values()).some(
        (s) => s.hospitalId === hospitalId && s.bloodGroup === bg
      );
      if (!exists) {
        const id = crypto.randomUUID();
        this.hospitalBloodStock.set(id, {
          id,
          hospitalId,
          bloodGroup: bg,
          unitsAvailable: 0,
          lastUpdated: new Date(),
        });
      }
    }
    this.save();
  }

  async createAnnouncement(data: InsertAnnouncement): Promise<Announcement> {
    const id = crypto.randomUUID();
    const created: Announcement = {
      id,
      title: data.title,
      message: data.message,
      createdBy: data.createdBy,
      targetBloodGroup: (data.targetBloodGroup as BloodGroup) || null,
      targetUserId: data.targetUserId || null,
      relatedRequestId: data.relatedRequestId || null,
      type: data.type || "general",
      createdAt: new Date(),
    };
    this.announcements.set(id, created);
    this.save();
    return created;
  }

  async getAnnouncements(userBloodGroup?: string, userId?: string): Promise<(Announcement & { creatorName: string })[]> {
    const list = Array.from(this.announcements.values()).filter((a) => {
      if (userId) {
        if (a.targetUserId === userId) return true;
        if (!a.targetUserId) {
          if (!a.targetBloodGroup || a.targetBloodGroup === userBloodGroup) return true;
        }
        return false;
      } else {
        if (a.targetUserId) return false;
        if (!userBloodGroup) return !a.targetBloodGroup;
        return !a.targetBloodGroup || a.targetBloodGroup === userBloodGroup;
      }
    });

    list.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));

    return list.map((a) => ({
      ...a,
      creatorName: this.users.get(a.createdBy)?.name || "System",
    }));
  }

  async getStats(): Promise<{
    totalDonors: number;
    availableDonors: number;
    pendingRequests: number;
    completedDonations: number;
    totalHospitals: number;
  }> {
    const allUsers = Array.from(this.users.values());
    const donors = allUsers.filter((u) => u.role === "user" && u.canDonate);
    const availableDonors = donors.filter((u) => u.availabilityStatus);
    const pendingRequests = Array.from(this.bloodRequests.values()).filter(
      (r) => r.status === "pending" || r.status === "accepted"
    );
    const completedDonations = Array.from(this.bloodRequests.values()).filter(
      (r) => r.status === "completed"
    );
    const totalHospitals = allUsers.filter((u) => u.role === "hospital").length;

    return {
      totalDonors: donors.length,
      availableDonors: availableDonors.length,
      pendingRequests: pendingRequests.length,
      completedDonations: completedDonations.length,
      totalHospitals,
    };
  }
}

// Check database connectivity or use FileStorage fallback
let storageInstance: IStorage;

if (process.env.USE_FILE_STORAGE === "true" || !process.env.DATABASE_URL) {
  console.log("[storage] Using local file storage (data/local_db.json)");
  storageInstance = new FileStorage();
} else {
  // Test connection asynchronously or fallback gracefully
  try {
    if (pool) {
      console.log("[storage] Initializing with DatabaseStorage with fallback");
      const dbStorage = new DatabaseStorage();
      const fileStorage = new FileStorage();

      // Proxy to seamlessly fall back if DB is unreachable
      let isPostgresHealthy: boolean | null = null;

      const checkHealth = async () => {
        if (isPostgresHealthy !== null) return isPostgresHealthy;
        try {
          if (!pool) throw new Error("No pool");
          const client = await pool.connect();
          client.release();
          isPostgresHealthy = true;
          console.log("[storage] PostgreSQL connected successfully");
          return true;
        } catch (e: any) {
          isPostgresHealthy = false;
          console.warn("[storage] PostgreSQL not reachable, switched to local file storage:", e.message);
          return false;
        }
      };

      // Wrap in dynamic proxy that uses dbStorage if healthy, else fileStorage
      storageInstance = new Proxy(dbStorage, {
        get(target: any, prop: string) {
          if (prop === "isDbConnected") {
            return () => isPostgresHealthy === true;
          }
          return async (...args: any[]) => {
            const healthy = await checkHealth();
            if (healthy) {
              try {
                return await target[prop](...args);
              } catch (err: any) {
                if (err.code === "ECONNREFUSED" || err.message?.includes("connect")) {
                  isPostgresHealthy = false;
                  console.warn("[storage] PostgreSQL query failed, switching to local file storage");
                  return await (fileStorage as any)[prop](...args);
                }
                throw err;
              }
            } else {
              return await (fileStorage as any)[prop](...args);
            }
          };
        },
      });
    } else {
      console.log("[storage] No DB pool, using FileStorage");
      storageInstance = new FileStorage();
    }
  } catch (err) {
    console.warn("[storage] Error initializing DB storage, falling back to FileStorage:", err);
    storageInstance = new FileStorage();
  }
}

export const storage = storageInstance;
