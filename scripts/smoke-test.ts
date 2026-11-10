// End-to-end test of the release 1 flows. Needs the API running (npm run dev) and the super admin seeded (npm run seed).
// Creates its own records, checks the behaviour in the BRD, then removes them.
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";

const BASE = process.env.BASE_URL ?? `http://localhost:${env.PORT}`;
const TAG = `smoke${Date.now()}`;
const PASSWORD = "Smoke-Pass-2026";
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, condition: unknown, detail?: unknown) {
  const ok = Boolean(condition);
  results.push({ name, ok, detail: ok ? undefined : JSON.stringify(detail)?.slice(0, 400) });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok ? "" : `  ->  ${JSON.stringify(detail)?.slice(0, 300)}`}`);
}

class Client {
  token = "";
  async call(method: string, url: string, body?: unknown, form?: FormData) {
    const headers: Record<string, string> = {};
    if (this.token) headers.cookie = `token=${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(BASE + url, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    for (const cookie of response.headers.getSetCookie()) {
      const match = /^token=([^;]*)/.exec(cookie);
      if (match) this.token = match[1];
    }
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: response.status, body: json, raw: text, headers: response.headers };
  }
  get = (url: string) => this.call("GET", url);
  post = (url: string, body?: unknown) => this.call("POST", url, body ?? {});
  patch = (url: string, body?: unknown) => this.call("PATCH", url, body ?? {});
  put = (url: string, body?: unknown) => this.call("PUT", url, body ?? {});
  delete = (url: string) => this.call("DELETE", url);
}

const image = (r: number, g: number, b: number) =>
  sharp({ create: { width: 900, height: 600, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
const fileForm = async (field: string, files: Array<{ name: string; data: Buffer; type: string }>) => {
  const form = new FormData();
  for (const file of files) form.append(field, new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
  return form;
};
const pdf = () => Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");

async function tokenFromMail(email: string, template: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const job = await prisma.mailJob.findFirst({ where: { toEmail: email, template }, orderBy: { createdAt: "desc" } });
    const match = job && /token=([a-f0-9]{20,})/.exec(job.html);
    if (match) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No ${template} mail found for ${email}`);
}

async function registerVerified(label: string) {
  const email = `${TAG}-${label}@example.test`;
  const client = new Client();
  const registered = await client.post("/api/auth/register", { email, password: PASSWORD, fullName: `Smoke ${label}`, phone: "+63 917 123 4567" });
  const token = await tokenFromMail(email, "verify_email");
  await client.post("/api/auth/verify-email", { token });
  return { client, email, id: registered.body?.id as string };
}

async function completeIdentity(client: Client) {
  const profile = await client.patch("/api/users/me", { idType: "passport", idNumber: "P1234567", dateOfBirth: "1990-05-20", city: "Makati", country: "Philippines" });
  const upload = await client.call("POST", "/api/users/me/id-document", undefined, await fileForm("document", [{ name: "passport.pdf", data: pdf(), type: "application/pdf" }]));
  return { profile, upload };
}

async function run() {
  console.log(`\nSmoke test against ${BASE}  (tag ${TAG})\n`);

  // ── Health
  const health = await new Client().get("/api/health");
  check("health: API and database are up", health.status === 200 && health.body?.database === true, health.body);

  const config = await new Client().get("/api/public/config");
  check("currency is PHP", config.body?.currency === "PHP", config.body);

  // ── Registration, validation, verification
  const emailA = `${TAG}-owner@example.test`;
  const owner = new Client();
  const reg = await owner.post("/api/auth/register", { email: emailA, password: PASSWORD, fullName: "Smoke Owner", phone: "+63 917 123 4567" });
  check("register: 201 with user ID, role user, unverified", reg.status === 201 && /^\d{3,}$/.test(reg.body?.userId) && reg.body.roles.join() === "user" && reg.body.emailVerified === false, reg.body);
  check("register: duplicate email is 409", (await new Client().post("/api/auth/register", { email: emailA.toUpperCase(), password: PASSWORD, fullName: "Dup" })).status === 409);
  check("register: short password is 400", (await new Client().post("/api/auth/register", { email: `${TAG}-x@example.test`, password: "123", fullName: "X" })).status === 400);
  check("register: bad email is 400", (await new Client().post("/api/auth/register", { email: "abc", password: PASSWORD, fullName: "X" })).status === 400);
  check("register: cannot pick a role", reg.body?.roles?.length === 1);

  const blocked = await owner.post("/api/properties", { name: "Blocked", propertyType: "house", streetAddress: "1 Street", city: "Makati", province: "Metro Manila", country: "UAE" });
  check("unverified user cannot submit a property (403)", blocked.status === 403, blocked.body);

  const verifyToken = await tokenFromMail(emailA, "verify_email");
  check("verify-email: first use works", (await owner.post("/api/auth/verify-email", { token: verifyToken })).status === 200);
  check("verify-email: link works only once", (await owner.post("/api/auth/verify-email", { token: verifyToken })).status === 400);
  check("verify-email: garbage token is 400", (await owner.post("/api/auth/verify-email", { token: "a".repeat(64) })).status === 400);

  const me = await owner.get("/api/auth/me");
  check("me: verified, userId present", me.body?.emailVerified === true && Boolean(me.body?.userId), me.body);

  // ── Login
  check("login: wrong password is 401", (await new Client().post("/api/auth/login", { email: emailA, password: "wrong-password" })).status === 401);
  check("login: unknown email is 401", (await new Client().post("/api/auth/login", { email: `${TAG}-nobody@example.test`, password: PASSWORD })).status === 401);
  const relog = new Client();
  check("login: correct password is 200", (await relog.post("/api/auth/login", { email: emailA, password: PASSWORD })).status === 200);
  check("me: no cookie is 401", (await new Client().get("/api/auth/me")).status === 401);

  // ── Profile and identity
  const bad = await owner.patch("/api/users/me", { dateOfBirth: "2015-01-01", idType: "passport" });
  check("profile: unknown role field rejected", (await owner.patch("/api/users/me", { roles: ["admin"] })).status === 400);
  void bad;
  const identity = await completeIdentity(owner);
  check("profile: identity saved and ID document uploaded", identity.profile.status === 200 && identity.upload.status === 201, [identity.profile.body, identity.upload.body]);
  const privateDoc = await owner.get(`/api/files/${identity.upload.body?.id}/download`);
  check("ID document: owner can download it", privateDoc.status === 200);
  check("ID document: not reachable through /uploads", (await fetch(`${BASE}/uploads/${identity.upload.body?.id}`)).status === 404);

  // ── Property creation and submission rules
  const propertyBody = {
    name: `Sunrise Tower ${TAG}`,
    propertyType: "apartment_building",
    description: "Modern building near the metro.",
    streetAddress: "12 Ayala Avenue",
    city: "Makati",
    province: "Metro Manila",
    country: "Philippines",
    latitude: 14.5547,
    longitude: 121.0244,
    yearBuilt: 2018,
    totalFloors: 30,
    parkingSlots: 80,
    amenities: ["swimming_pool", "gym", "security"],
  };
  const created = await owner.post("/api/properties", propertyBody);
  const propertyId = created.body?.id as string;
  check("property: created as Pending draft, not yet submitted", created.status === 201 && created.body.approvalStatus === "Pending" && created.body.submittedAt === null && created.body.listingStatus === "Draft" && /^P-\d{3,}$/.test(created.body.code), created.body);
  check("property: bad amenity is 400", (await owner.post("/api/properties", { ...propertyBody, amenities: ["moat"] })).status === 400);
  check("property: only one of latitude/longitude is 400", (await owner.post("/api/properties", { ...propertyBody, longitude: undefined })).status === 400);

  const countBefore = (await owner.get("/api/properties?pageSize=100")).body?.total;
  const combo = await owner.post("/api/properties", { ...propertyBody, name: `Combo ${TAG}`, landmark: "Near the metro station", unit: { unitNumber: "1", unitType: "studio", bedrooms: 0, bathrooms: 1, floorArea: 40, furnishing: "Unfurnished", monthlyRent: 3000, utilities: "AllIncluded", noticePeriodMonths: 1 } });
  check("property: created together with its first home in one request", combo.status === 201 && combo.body.units?.length === 1 && combo.body.units[0].utilities === "AllIncluded" && combo.body.units[0].noticePeriodMonths === 1 && combo.body.address.landmark === "Near the metro station", combo.body);
  const badCombo = await owner.post("/api/properties", { ...propertyBody, name: `Bad ${TAG}`, unit: { unitNumber: "1", unitType: "studio", bedrooms: -1, bathrooms: 1, floorArea: 40, furnishing: "Unfurnished", monthlyRent: 3000 } });
  check("property: a bad first home creates nothing (400, no orphan property)", badCombo.status === 400 && (await owner.get("/api/properties?pageSize=100")).body?.total === countBefore + 1);

  const early = await owner.post(`/api/properties/${propertyId}/submit`);
  check("submit: refused without photos and documents (422)", early.status === 422 && Array.isArray(early.body?.details) && early.body.details.length === 2, early.body);

  const photos = await owner.call("POST", `/api/properties/${propertyId}/photos`, undefined, await fileForm("photos", [
    { name: "a.jpg", data: await image(200, 80, 80), type: "image/jpeg" },
    { name: "b.jpg", data: await image(80, 200, 80), type: "image/jpeg" },
    { name: "c.jpg", data: await image(80, 80, 200), type: "image/jpeg" },
  ]));
  check("photos: 3 uploaded, first is the cover", photos.status === 201 && photos.body.length === 3 && photos.body[0].isCover === true && !photos.body[1].isCover, photos.body);
  const photoUrl = photos.body?.[0]?.url as string;
  const served = await fetch(BASE + photoUrl);
  check("photos: public image is served as WebP", served.status === 200 && served.headers.get("content-type") === "image/webp", served.status);
  check("photos: thumbnail exists", (await fetch(BASE + photos.body[0].thumbUrl)).status === 200);

  const fakeImage = await owner.call("POST", `/api/properties/${propertyId}/photos`, undefined, await fileForm("photos", [{ name: "fake.jpg", data: Buffer.from("this is not an image"), type: "image/jpeg" }]));
  check("photos: a fake image is rejected (400)", fakeImage.status === 400, fakeImage.body);
  const textFile = await owner.call("POST", `/api/properties/${propertyId}/photos`, undefined, await fileForm("photos", [{ name: "x.txt", data: Buffer.from("hello"), type: "text/plain" }]));
  check("photos: wrong file type is rejected (400)", textFile.status === 400, textFile.body);
  const tooBig = await owner.call("POST", `/api/properties/${propertyId}/photos`, undefined, await fileForm("photos", [{ name: "big.jpg", data: Buffer.alloc(6 * 1024 * 1024, 1), type: "image/jpeg" }]));
  check("photos: file over 5 MB is rejected (413)", tooBig.status === 413, tooBig.body);

  const docs = await owner.call("POST", `/api/properties/${propertyId}/documents`, undefined, await fileForm("documents", [{ name: "title-deed.pdf", data: pdf(), type: "application/pdf" }]));
  check("documents: ownership document stored privately", docs.status === 201 && docs.body[0].isPrivate === true && docs.body[0].url === null, docs.body);
  check("documents: owner can download", (await owner.get(`/api/files/${docs.body[0].id}/download`)).status === 200);

  // ── Units
  const unitBody = { unitNumber: "12A", floor: 12, unitType: "two_bedroom", bedrooms: 2, bathrooms: 2.5, floorArea: 110.5, furnishing: "SemiFurnished", monthlyRent: 7500, securityDeposit: 7500, minLeaseMonths: 12, availableFrom: "2026-12-01", petsAllowed: true, features: ["balcony", "air_conditioning"] };
  const unit = await owner.post(`/api/properties/${propertyId}/units`, unitBody);
  const unitId = unit.body?.id as string;
  check("unit: created Vacant with code and numeric rent", unit.status === 201 && unit.body.status === "Vacant" && unit.body.monthlyRent === 7500 && unit.body.bathrooms === 2.5 && /^U-\d{3,}$/.test(unit.body.code), unit.body);
  check("unit: bathrooms 1.3 is 400", (await owner.post(`/api/properties/${propertyId}/units`, { ...unitBody, unitNumber: "9", bathrooms: 1.3 })).status === 400);
  check("unit: rent with 3 decimals is 400", (await owner.post(`/api/properties/${propertyId}/units`, { ...unitBody, unitNumber: "9", monthlyRent: 100.123 })).status === 400);
  check("unit: negative bedrooms is 400", (await owner.post(`/api/properties/${propertyId}/units`, { ...unitBody, unitNumber: "9", bedrooms: -1 })).status === 400);
  check("unit: duplicate number is 409", (await owner.post(`/api/properties/${propertyId}/units`, { ...unitBody, unitNumber: "12a" })).status === 409);
  const unitPhoto = await owner.call("POST", `/api/units/${unitId}/photos`, undefined, await fileForm("photos", [{ name: "u.jpg", data: await image(150, 150, 60), type: "image/jpeg" }]));
  check("unit: photo uploaded", unitPhoto.status === 201 && unitPhoto.body[0].isCover === true, unitPhoto.body);
  check("unit: manual Occupied is rejected", (await owner.patch(`/api/units/${unitId}/status`, { status: "Occupied" })).status === 400);

  // ── Submit and review
  const submitted = await owner.post(`/api/properties/${propertyId}/submit`);
  check("submit: accepted", submitted.status === 200 && submitted.body.submittedAt !== null, submitted.body);
  check("submit: second submit is 409", (await owner.post(`/api/properties/${propertyId}/submit`)).status === 409);

  const admin = new Client();
  const adminLogin = await admin.post("/api/auth/login", { email: env.SEED_SUPER_ADMIN_EMAIL ?? process.env.SEED_SUPER_ADMIN_EMAIL, password: process.env.SEED_SUPER_ADMIN_PASSWORD });
  check("super admin can log in", adminLogin.status === 200 && adminLogin.body.roles.includes("super_admin"), adminLogin.body);

  const queue = await admin.get("/api/properties?queue=pending&pageSize=100");
  check("review queue lists the submitted property", queue.body?.items?.some((item: any) => item.id === propertyId), queue.body?.total);
  const adminNotes = await admin.get("/api/notifications?unread=true&pageSize=100");
  check("admins were notified of the submission", adminNotes.body?.items?.some((item: any) => item.type === "property.review_needed" && item.message.includes("Smoke Owner")), adminNotes.body?.unreadCount);

  check("review: owner cannot approve (403)", (await owner.post(`/api/properties/${propertyId}/review`, { action: "approve" })).status === 403);
  check("review: rejection needs a reason (400)", (await admin.post(`/api/properties/${propertyId}/review`, { action: "reject" })).status === 400);
  const rejected = await admin.post(`/api/properties/${propertyId}/review`, { action: "reject", reason: "The ownership document is unclear." });
  check("review: rejected with reason", rejected.status === 200 && rejected.body.approvalStatus === "Rejected" && rejected.body.rejectionReason.includes("unclear"), rejected.body);
  const ownerNotes = await owner.get("/api/notifications?pageSize=100");
  check("owner was notified of the rejection with the reason", ownerNotes.body?.items?.some((item: any) => item.type === "property.rejected" && item.message.includes("unclear")), ownerNotes.body?.items?.map((i: any) => i.type));
  check("review: a rejected property is not public", (await new Client().get(`/api/public/listings/${unitId}`)).status === 404);
  check("review: cannot decide twice (409)", (await admin.post(`/api/properties/${propertyId}/review`, { action: "approve" })).status === 409);

  const resubmitted = await owner.post(`/api/properties/${propertyId}/submit`);
  check("resubmit: same record goes back to Pending and clears the reason", resubmitted.status === 200 && resubmitted.body.approvalStatus === "Pending" && resubmitted.body.rejectionReason === null, resubmitted.body);

  const approved = await admin.post(`/api/properties/${propertyId}/review`, { action: "approve" });
  check("review: approved and Listed", approved.status === 200 && approved.body.approvalStatus === "Approved" && approved.body.listingStatus === "Listed", approved.body);
  const meAfter = await owner.get("/api/auth/me");
  check("approval: submitter now has the owner role without logging in again", meAfter.body?.roles?.includes("owner") && meAfter.body.roles.includes("user"), meAfter.body?.roles);
  const ownerNotes2 = await owner.get("/api/notifications?pageSize=100");
  check("owner got approval and role-change notifications", ["property.approved", "account.role_changed"].every((type) => ownerNotes2.body?.items?.some((item: any) => item.type === type)));

  // ── Public site
  const publicList = await new Client().get(`/api/public/listings?city=makati&minRent=7000&maxRent=8000&bedrooms=2&bathrooms=2&amenities=gym,security&sort=price_asc`);
  const found = publicList.body?.items?.find((item: any) => item.id === unitId);
  check("public: listing found with filters, cover photo and PHP", Boolean(found) && found.coverPhoto?.url && publicList.body.currency === "PHP", publicList.body);
  check("public: card carries photos for the carousel and the details shown as chips", found?.photos?.length >= 2 && found.utilities !== undefined && found.petsAllowed === true, found);
  check("public: too-high bedroom filter hides it", !(await new Client().get(`/api/public/listings?bedrooms=5&city=makati`)).body?.items?.some((item: any) => item.id === unitId));
  check("public: unknown amenity filter is 400", (await new Client().get(`/api/public/listings?amenities=moat`)).status === 400);
  const detail = await new Client().get(`/api/public/listings/${unitId}`);
  check("public: detail has gallery, amenities and map location", detail.status === 200 && detail.body.gallery.length === 4 && detail.body.property.amenities.includes("gym") && detail.body.property.location?.latitude === 14.5547, detail.body?.gallery?.length);
  check("public: detail does not leak owner or documents", !/Smoke Owner|owner@|ownership|title-deed/.test(detail.raw), detail.raw.slice(0, 200));
  const filters = await new Client().get("/api/public/filters");
  check("public: filters include the city", filters.body?.cities?.includes("Makati"), filters.body);
  check("public: filters give a count per city for the popular areas", filters.body?.cityCounts?.some((row: any) => row.city === "Makati" && row.count >= 1), filters.body?.cityCounts);

  // ── Access control on properties
  const stranger = await registerVerified("stranger");
  check("property: a stranger cannot read it (404)", (await stranger.client.get(`/api/properties/${propertyId}`)).status === 404);
  check("property: a stranger cannot edit it (404)", (await stranger.client.patch(`/api/properties/${propertyId}`, { name: "Hacked" })).status === 404);
  check("property: a stranger cannot download its documents (404)", (await stranger.client.get(`/api/files/${docs.body[0].id}/download`)).status === 404);
  check("property: stranger's list does not include it", !(await stranger.client.get("/api/properties")).body?.items?.some((item: any) => item.id === propertyId));
  check("property: owner can hide it", (await owner.patch(`/api/properties/${propertyId}/listing`, { listingStatus: "Hidden" })).body?.listingStatus === "Hidden");
  check("property: hidden listing disappears from the public site", (await new Client().get(`/api/public/listings/${unitId}`)).status === 404);
  await owner.patch(`/api/properties/${propertyId}/listing`, { listingStatus: "Listed" });
  const adminEdit = await admin.patch(`/api/properties/${propertyId}`, { description: "Updated by admin" });
  check("property: admin edit works and the owner is notified", adminEdit.status === 200 && (await owner.get("/api/notifications?pageSize=100")).body?.items?.some((item: any) => item.type === "property.edited"));
  check("delete: cannot delete the last photo below the minimum (409)", (await owner.delete(`/api/files/${photos.body[0].id}`)).status === 409);

  // ── Renting
  const tenant = stranger;
  const earlyRequest = await tenant.client.post(`/api/units/${unitId}/rent-requests`, { message: "I would like to rent." });
  check("rent request: refused until identity is complete (422)", earlyRequest.status === 422, earlyRequest.body);
  await completeIdentity(tenant.client);
  const rentRequest = await tenant.client.post(`/api/units/${unitId}/rent-requests`, { message: "I would like to rent." });
  check("rent request: created Pending", rentRequest.status === 201 && rentRequest.body.status === "Pending", rentRequest.body);
  check("rent request: duplicate is 409", (await tenant.client.post(`/api/units/${unitId}/rent-requests`, {})).status === 409);
  check("rent request: owner cannot rent their own unit (403)", (await owner.post(`/api/units/${unitId}/rent-requests`, {})).status === 403);
  check("rent request: owner cannot decide it (403)", (await owner.post(`/api/rent-requests/${rentRequest.body.id}/decision`, { action: "approve" })).status === 403);
  check("rent request: admin sees the requester", (await admin.get("/api/rent-requests?status=Pending&pageSize=100")).body?.items?.some((item: any) => item.id === rentRequest.body.id && item.requester?.email === tenant.email));

  const decision = await admin.post(`/api/rent-requests/${rentRequest.body.id}/decision`, { action: "approve", startDate: "2026-12-01" });
  check("rent request: approved", decision.status === 200 && decision.body.status === "Approved", decision.body);
  const tenantMe = await tenant.client.get("/api/auth/me");
  check("approval: tenant role added, user role kept (user + tenant)", tenantMe.body?.roles?.includes("tenant") && tenantMe.body.roles.includes("user"), tenantMe.body?.roles);
  const unitAfter = await owner.get(`/api/units/${unitId}`);
  check("approval: unit is now Occupied", unitAfter.body?.status === "Occupied", unitAfter.body?.status);
  check("approval: occupied unit leaves the public site", (await new Client().get(`/api/public/listings/${unitId}`)).status === 404);
  check("approval: second request on an occupied unit is 404", (await stranger.client.post(`/api/units/${unitId}/rent-requests`, {})).status === 404);
  const tenantNotes = await tenant.client.get("/api/notifications?pageSize=100");
  check("tenant notified: unit assigned and role changed", ["tenancy.started", "account.role_changed"].every((type) => tenantNotes.body?.items?.some((item: any) => item.type === type)));
  check("owner notified: tenant linked", (await owner.get("/api/notifications?pageSize=100")).body?.items?.some((item: any) => item.type === "tenancy.started"));

  const tenancies = await tenant.client.get("/api/tenancies");
  const tenancyId = tenancies.body?.items?.[0]?.id as string;
  check("tenancy: tenant sees their own", tenancies.body?.total === 1 && tenancies.body.items[0].status === "Active" && tenancies.body.items[0].startDate === "2026-12-01" && tenancies.body.items[0].tenant === undefined, tenancies.body);
  const ownerTenancies = await owner.get("/api/tenancies");
  check("tenancy: owner sees it with the tenant's name only", ownerTenancies.body?.items?.[0]?.tenant?.fullName === "Smoke stranger" && ownerTenancies.body.items[0].tenant.email === undefined, ownerTenancies.body);
  check("tenancy: tenant cannot end it (403)", (await tenant.client.post(`/api/tenancies/${tenancyId}/end`, {})).status === 403);
  check("delete: cannot remove a unit with tenancy history (409)", (await owner.delete(`/api/units/${unitId}`)).status === 409);
  check("archive: cannot archive a property with an active tenancy (409)", (await admin.delete(`/api/properties/${propertyId}`)).status === 409);
  check("roles: cannot remove tenant role during an active tenancy (409)", (await admin.delete(`/api/users/${tenant.id}/roles/tenant`)).status === 409);

  const ended = await admin.post(`/api/tenancies/${tenancyId}/end`, { endDate: "2027-01-31" });
  check("tenancy: ended", ended.status === 200 && ended.body.status === "Ended" && ended.body.endDate === "2027-01-31", ended.body);
  check("tenancy ended: unit is Vacant again", (await owner.get(`/api/units/${unitId}`)).body?.status === "Vacant");
  check("tenancy ended: tenant role removed, user role kept", (await tenant.client.get("/api/auth/me")).body?.roles?.join() === "user");

  // ── Admin: people, roles, staff
  const staffEmail = `${TAG}-staff@example.test`;
  check("staff: only a super admin can create an admin", (await owner.post("/api/users/staff", { email: staffEmail, fullName: "X", role: "admin" })).status === 403);
  const staffCreated = await admin.post("/api/users/staff", { email: staffEmail, fullName: "Smoke Staff", role: "admin" });
  check("staff: super admin creates an admin", staffCreated.status === 201 && staffCreated.body.roles.includes("admin"), staffCreated.body);
  const inviteToken = await tokenFromMail(staffEmail, "staff_invite");
  const staff = new Client();
  check("staff: invited admin sets a password", (await staff.post("/api/auth/reset-password", { token: inviteToken, password: PASSWORD })).status === 200);
  check("staff: invited admin can log in", (await staff.post("/api/auth/login", { email: staffEmail, password: PASSWORD })).status === 200);

  check("admin: can add the tenant role", (await staff.post(`/api/users/${tenant.id}/roles`, { role: "tenant" })).status === 201);
  check("admin: cannot grant owner (403)", (await staff.post(`/api/users/${tenant.id}/roles`, { role: "owner" })).status === 403);
  check("admin: cannot grant admin (403)", (await staff.post(`/api/users/${tenant.id}/roles`, { role: "admin" })).status === 403);
  check("admin: cannot remove the base user role (400)", (await admin.delete(`/api/users/${tenant.id}/roles/user`)).status === 400);
  const superId = adminLogin.body.id as string;
  check("admin: cannot touch a super admin (403)", (await staff.patch(`/api/users/${superId}/status`, { status: "Suspended" })).status === 403);
  check("admin: cannot change their own account (403)", (await admin.patch(`/api/users/${superId}/status`, { status: "Suspended" })).status === 403);
  check("admin: removes the tenant role again", (await staff.delete(`/api/users/${tenant.id}/roles/tenant`)).status === 200);
  check("users: list needs staff (403 for owner)", (await owner.get("/api/users")).status === 403);
  const search = await staff.get(`/api/users?q=${TAG}&pageSize=50`);
  check("users: staff can search by text", search.body?.items?.length >= 3 && !("idNumber" in search.body.items[0]), search.body?.total);
  const detailUser = await staff.get(`/api/users/${tenant.id}`);
  check("users: staff see ID details on a profile", detailUser.body?.idNumber === "P1234567", detailUser.body);

  const suspended = await staff.patch(`/api/users/${tenant.id}/status`, { status: "Suspended", note: "Smoke test" });
  check("suspend: works", suspended.status === 200 && suspended.body.status === "Suspended", suspended.body);
  const afterSuspend = (await tenant.client.get("/api/auth/me")).status;
  check("suspend: existing session stops working at once (401 or 403)", afterSuspend === 401 || afterSuspend === 403, afterSuspend);
  check("suspend: login is refused (403)", (await new Client().post("/api/auth/login", { email: tenant.email, password: PASSWORD })).status === 403);
  check("suspend: user was told by in-app notification", (await prisma.notification.count({ where: { userId: tenant.id, type: "account.status_changed" } })) === 1);
  check("reactivate: works and login returns", (await staff.patch(`/api/users/${tenant.id}/status`, { status: "Active" })).status === 200 && (await tenant.client.post("/api/auth/login", { email: tenant.email, password: PASSWORD })).status === 200);

  // ── Passwords and sessions
  const second = new Client();
  await second.post("/api/auth/login", { email: tenant.email, password: PASSWORD });
  check("password: wrong current password is 400", (await tenant.client.post("/api/auth/change-password", { currentPassword: "nope-nope-1", newPassword: "Another-Pass-2026" })).status === 400);
  check("password: change works", (await tenant.client.post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "Another-Pass-2026" })).status === 200);
  check("password: this device stays signed in", (await tenant.client.get("/api/auth/me")).status === 200);
  check("password: other devices are signed out (401)", (await second.get("/api/auth/me")).status === 401);
  const forgot = await new Client().post("/api/auth/forgot-password", { email: tenant.email });
  const forgotUnknown = await new Client().post("/api/auth/forgot-password", { email: `${TAG}-ghost@example.test` });
  check("forgot-password: same answer for known and unknown emails", forgot.status === 200 && forgotUnknown.status === 200 && forgot.body.message === forgotUnknown.body.message);
  const resetToken = await tokenFromMail(tenant.email, "reset_password");
  const resetClient = new Client();
  check("reset-password: works", (await resetClient.post("/api/auth/reset-password", { token: resetToken, password: PASSWORD })).status === 200);
  check("reset-password: link is single use (400)", (await resetClient.post("/api/auth/reset-password", { token: resetToken, password: PASSWORD })).status === 400);
  check("reset-password: old session is signed out (401)", (await tenant.client.get("/api/auth/me")).status === 401);
  await new Client().post("/api/auth/forgot-password", { email: tenant.email });
  await new Client().post("/api/auth/forgot-password", { email: tenant.email });
  check("forgot-password: limited to 3 emails an hour", (await prisma.authToken.count({ where: { userId: tenant.id, type: "password_reset" } })) === 3);

  const victim = await registerVerified("lock");
  let lockStatus = 0;
  for (let attempt = 0; attempt < 5; attempt++) lockStatus = (await new Client().post("/api/auth/login", { email: victim.email, password: "wrong-password-1" })).status;
  check("lockout: 5 wrong passwords in a row each answer 401", lockStatus === 401, lockStatus);
  check("lockout: the account is locked in the database", (await prisma.user.findUnique({ where: { id: victim.id } }))?.lockedUntil !== null);
  const locked = await new Client().post("/api/auth/login", { email: victim.email, password: PASSWORD });
  check("lockout: even the right password is refused for 15 minutes (429)", locked.status === 429 && /failed attempts/.test(locked.body?.error ?? ""), locked.body);

  // ── Notifications
  const bell = await owner.get("/api/notifications/unread-count");
  check("notifications: unread count", bell.body?.unreadCount > 0, bell.body);
  const first = (await owner.get("/api/notifications?unread=true")).body?.items?.[0];
  check("notifications: mark one as read", (await owner.patch(`/api/notifications/${first.id}/read`)).body?.read === true);
  check("notifications: somebody else's is 404", (await victim.client.patch(`/api/notifications/${first.id}/read`)).status === 404);
  check("notifications: mark all as read", (await owner.post("/api/notifications/read-all")).status === 200 && (await owner.get("/api/notifications/unread-count")).body?.unreadCount === 0);
  check("notifications: delete one", (await owner.delete(`/api/notifications/${first.id}`)).status === 200);
  await owner.patch("/api/users/me", { notifyInApp: false });
  const beforeCount = (await owner.get("/api/notifications?pageSize=1")).body.total;
  await admin.patch(`/api/properties/${propertyId}`, { description: "Another admin edit" });
  check("notifications: respects the in-app preference", (await owner.get("/api/notifications?pageSize=1")).body.total === beforeCount);
  await owner.patch("/api/users/me", { notifyInApp: true });

  const announcementTitle = `Smoke announcement ${TAG}`;
  check("announcement: owner cannot send (403)", (await owner.post("/api/announcements", { title: "x", message: "y", audience: "all" })).status === 403);
  const announcement = await admin.post("/api/announcements", { title: announcementTitle, message: "Water maintenance on Friday.", audience: "owners" });
  check("announcement: sent to owners", announcement.status === 201 && announcement.body.recipientCount >= 1, announcement.body);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  check("announcement: owner receives it, a plain user does not", (await owner.get("/api/notifications?pageSize=100")).body?.items?.some((item: any) => item.title === announcementTitle) && !(await victim.client.get("/api/notifications?pageSize=100")).body?.items?.some((item: any) => item.title === announcementTitle));

  // ── Settings (restored afterwards)
  const savedEmailSetting = await prisma.systemSetting.findUnique({ where: { key: "email.smtp" } });
  check("settings: owner is refused (403)", (await owner.get("/api/settings/email")).status === 403);
  check("settings: admin (not super) is refused (403)", (await staff.get("/api/settings/email")).status === 403);
  const smtp = await admin.put("/api/settings/email", { host: "smtp.example.test", port: 465, encryption: "ssl", username: "noreply@example.test", password: "super-secret-pass", fromName: "RentEasy", fromAddress: "noreply@example.test", replyTo: "support@example.test", adminAlertEmail: "ops@example.test" });
  check("settings: SMTP saved, password never returned", smtp.status === 200 && smtp.body.passwordSet === true && !JSON.stringify(smtp.body).includes("super-secret"), smtp.body);
  const stored = await prisma.systemSetting.findUnique({ where: { key: "email.smtp" } });
  check("settings: password is stored encrypted", Boolean(stored) && !stored!.value.includes("super-secret-pass"));
  check("settings: keeping the password when left blank", (await admin.put("/api/settings/email", { host: "smtp.example.test", port: 587, encryption: "starttls", username: "noreply@example.test", fromName: "RentEasy", fromAddress: "noreply@example.test" })).body?.passwordSet === true);
  check("settings: bad port is 400", (await admin.put("/api/settings/email", { host: "h", port: 99999, encryption: "ssl", username: "u", fromName: "n", fromAddress: "a@b.co" })).status === 400);
  const testMail = await admin.post("/api/settings/email/test", { to: "someone@example.test" });
  check("settings: send test email (console mode)", testMail.status === 200 && testMail.body.ok === true, testMail.body);
  const templates = await admin.get("/api/settings/email-templates");
  check("settings: templates listed with placeholders", templates.body?.length >= 15 && templates.body.some((item: any) => item.key === "verify_email" && item.placeholders.includes("link")), templates.body?.length);
  check("settings: unknown placeholder rejected (400)", (await admin.put("/api/settings/email-templates/password_changed", { subject: "Hi {{secret}}", bodyHtml: "<p>x</p>" })).status === 400);
  check("settings: script in wording rejected (400)", (await admin.put("/api/settings/email-templates/password_changed", { subject: "Hi", bodyHtml: "<script>alert(1)</script>" })).status === 400);
  const custom = await admin.put("/api/settings/email-templates/password_changed", { subject: "Changed, {{name}}", bodyHtml: "<p>Custom wording for {{name}}</p>" });
  check("settings: custom wording saved", custom.status === 200 && custom.body.customised === true);
  check("settings: wording can be reset", (await admin.delete("/api/settings/email-templates/password_changed")).body?.customised === false);
  check("settings: currency readable", (await admin.get("/api/settings/general")).body?.currency === "PHP");
  if (savedEmailSetting) await prisma.systemSetting.update({ where: { key: "email.smtp" }, data: { value: savedEmailSetting.value } });
  else await prisma.systemSetting.deleteMany({ where: { key: "email.smtp" } });

  const mailLog = await admin.get(`/api/settings/mail-log?to=${TAG}&pageSize=100`);
  check("mail log: super admin sees recipient, subject, status and time", mailLog.status === 200 && mailLog.body.total >= 10 && mailLog.body.items[0].toEmail && mailLog.body.items[0].subject && mailLog.body.items[0].status && !("html" in mailLog.body.items[0]), mailLog.body?.total);
  check("mail log: admin (not super) is refused (403)", (await staff.get("/api/settings/mail-log")).status === 403);
  check("mail log: only a failed email can be retried (409)", (await admin.post(`/api/settings/mail-log/${mailLog.body.items[0].id}/retry`)).status === 409);
  const unitEdit = await staff.patch(`/api/units/${unitId}`, { description: "Edited by an admin" });
  check("unit: admin edit works and the owner is notified", unitEdit.status === 200 && (await owner.get("/api/notifications?pageSize=100")).body?.items?.some((item: any) => item.type === "unit.edited"), unitEdit.body);
  check("staff: new admin received a welcome notification", (await staff.get("/api/notifications?pageSize=100")).body?.items?.some((item: any) => item.type === "account.welcome"));

  // ── Audit log
  const audit = await staff.get(`/api/audit-logs?entityId=${propertyId}&pageSize=100`);
  const actions = new Set((audit.body?.items ?? []).map((item: any) => item.action));
  check("audit: property history is recorded", ["property.create", "property.submit", "property.reject", "property.approve"].every((action) => actions.has(action)), [...actions]);
  check("audit: owner cannot read the log (403)", (await owner.get("/api/audit-logs")).status === 403);

  // ── Email queue
  const tagMails = () => prisma.mailJob.findMany({ where: { toEmail: { contains: TAG } } });
  const total = (await tagMails()).length;
  check("mail: emails were queued for the flows above", total >= 15, total);
  let pending = 1;
  for (let wait = 0; wait < 40 && pending > 0; wait++) {
    pending = (await prisma.mailJob.count({ where: { toEmail: { contains: TAG }, status: "Queued" } }));
    if (pending > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const sent = await prisma.mailJob.count({ where: { toEmail: { contains: TAG }, status: "Sent" } });
  check("mail: the worker delivered every queued email", pending === 0 && sent === total, { pending, sent, total });
  const essentialOff = await prisma.mailJob.count({ where: { toEmail: tenant.email, template: "password_changed" } });
  check("mail: security emails are always sent", essentialOff >= 1);

  return { propertyId };
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  const ids = users.map((user) => user.id);
  const properties = await prisma.property.findMany({ where: { ownerId: { in: ids } }, select: { id: true, units: { select: { id: true } } } });
  await prisma.rentRequest.deleteMany({ where: { OR: [{ userId: { in: ids } }, { unit: { propertyId: { in: properties.map((p) => p.id) } } }] } });
  await prisma.tenancy.deleteMany({ where: { OR: [{ tenantId: { in: ids } }, { createdById: { in: ids } }, { unit: { propertyId: { in: properties.map((p) => p.id) } } }] } });
  await prisma.property.deleteMany({ where: { id: { in: properties.map((p) => p.id) } } });
  await prisma.announcement.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.mailJob.deleteMany({ where: { OR: [{ toEmail: { contains: TAG } }, { toEmail: "someone@example.test" }, { toEmail: "ops@example.test" }] } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: [...ids, ...properties.map((p) => p.id)] } }] } });
  const userFiles = await prisma.fileAsset.findMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  for (const file of userFiles) {
    await fs.rm(path.join(env.uploadRoot, file.storagePath), { force: true });
    if (file.thumbPath) await fs.rm(path.join(env.uploadRoot, file.thumbPath), { force: true });
  }
  for (const property of properties) {
    await fs.rm(path.join(env.uploadRoot, "public", "properties", property.id), { recursive: true, force: true });
    await fs.rm(path.join(env.uploadRoot, "private", "properties", property.id), { recursive: true, force: true });
    for (const unit of property.units) await fs.rm(path.join(env.uploadRoot, "public", "units", unit.id), { recursive: true, force: true });
  }
}

run()
  .catch((error) => {
    console.error("\nTest run crashed:", error);
    results.push({ name: "test run completed", ok: false, detail: String(error) });
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (error) {
      console.error("Cleanup problem:", error);
    }
    await prisma.$disconnect();
    const failed = results.filter((result) => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log("\nFailed:");
      for (const item of failed) console.log(`  - ${item.name}  ${item.detail ?? ""}`);
    }
    process.exit(failed.length > 0 ? 1 : 0);
  });
