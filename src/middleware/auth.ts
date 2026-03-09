import type { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config/index.js";
import { prisma } from "../lib/db.js";

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);

export interface AuthPayload {
  sub: string;
  email?: string;
  role?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = header.slice(7);

  supabase.auth
    .getUser(token)
    .then(({ data, error }) => {
      if (error || !data.user) {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
      }

      req.user = {
        sub: data.user.id,
        email: data.user.email,
        role: data.user.role,
      };
      next();
    })
    .catch(() => {
      res.status(401).json({ error: "Invalid or expired token" });
    });
}

/**
 * Resolve Supabase authProviderId to internal User.
 * Returns null if user hasn't called /api/auth/sync yet.
 */
export async function resolveUser(authProviderId: string) {
  return prisma.user.findFirst({
    where: { authProviderId },
  });
}
