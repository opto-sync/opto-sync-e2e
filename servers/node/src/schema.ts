import { pgTable, text, jsonb, integer, timestamp } from "drizzle-orm/pg-core";

export const syncerTestDocs = pgTable("syncer_test_docs", {
  id: text("id").primaryKey(),
  data: jsonb("data").notNull().default({}),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
