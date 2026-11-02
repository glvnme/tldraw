-- The conversion attempt a model's job token is scoped to. Set on every queue claim, so a token from
-- an earlier attempt can no longer write artifacts or status over a retry.
ALTER TABLE public.model ADD COLUMN "jobId" VARCHAR;
