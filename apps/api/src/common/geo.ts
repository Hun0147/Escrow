import { Request } from 'express';
import { findBlockedRegion } from '../db/repos/fraud.repo';
import { getSetting } from './settings';
import { AppError, forbidden } from './errors';

/**
 * Where the request appears to come from.
 *
 * In production the edge (CDN / load balancer) sets these headers; they are
 * not client-controllable there. Locally they can be set by hand, which is why
 * the geofence check ALSO uses the KYC address country — an IP check alone is
 * one VPN away from useless.
 */
export interface GeoContext {
  ipCountry: string | null;
  ipRegion: string | null;
  ip: string | null;
}

export function geoFromRequest(req: Request): GeoContext {
  const header = (name: string): string | null => {
    const value = req.headers[name];
    if (typeof value === 'string' && value.trim()) return value.trim().toUpperCase();
    return null;
  };
  return {
    ipCountry: header('cf-ipcountry') ?? header('x-geo-country'),
    ipRegion: header('x-geo-region'),
    ip: req.ip ?? null,
  };
}

export function ageOn(dateOfBirth: string, at: Date = new Date()): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) throw new AppError(400, 'invalid_dob', 'Date of birth is not a valid date');
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = at.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

export interface EligibilityCheck {
  countryCode: string;
  regionCode: string | null;
  dateOfBirth: string;
}

/**
 * Blocks play from restricted jurisdictions and enforces the age gate,
 * including jurisdictions with a higher minimum age than the platform default.
 */
export async function assertEligible(check: EligibilityCheck): Promise<void> {
  const blocked = await findBlockedRegion(check.countryCode, check.regionCode);
  const baseMinAge = await getSetting('min_age');
  const minAge = Math.max(baseMinAge, blocked?.minAge ?? 0);

  // A region entry with a minAge is an age restriction, not a ban.
  if (blocked && blocked.minAge === null) {
    throw forbidden(
      'region_blocked',
      `Goal 27 is not available in ${blocked.code}: ${blocked.reason}`,
    );
  }

  const age = ageOn(check.dateOfBirth);
  if (age < minAge) {
    throw forbidden('underage', `You must be at least ${minAge} to play for money here`);
  }
}
