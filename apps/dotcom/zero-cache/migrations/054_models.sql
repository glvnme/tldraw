-- 3D models uploaded to a workspace and converted to GLB. Server-only: NOT added to the zero_data
-- publication; the client polls the sync worker for status instead.
CREATE TABLE public.model (
	"id" VARCHAR PRIMARY KEY,
	"owningGroupId" VARCHAR NOT NULL REFERENCES public."group" ("id") ON DELETE CASCADE,
	"createdBy" VARCHAR NOT NULL,
	"name" VARCHAR NOT NULL,
	"sourceFormat" VARCHAR NOT NULL,
	"sourceBytes" BIGINT NOT NULL,
	"status" VARCHAR NOT NULL CHECK ("status" IN ('uploading', 'queued', 'converting', 'ready', 'failed')),
	"stage" VARCHAR,
	"progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
	"errorCode" VARCHAR,
	"manifest" JSONB,
	-- R2 multipart upload id, cleared once the upload completes
	"uploadId" VARCHAR,
	"createdAt" BIGINT NOT NULL,
	"updatedAt" BIGINT NOT NULL
);

CREATE INDEX model_owning_group_id_idx ON public.model ("owningGroupId");
