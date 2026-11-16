-- Preserve split history on direct position deletion while allowing account/user cascades.
ALTER TABLE "account_split_parcel_effects"
  ALTER CONSTRAINT "account_split_parcel_effects_positionId_fkey"
  DEFERRABLE INITIALLY DEFERRED;