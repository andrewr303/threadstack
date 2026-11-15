CREATE TABLE plugin_browser_sessions_d326bfce08.records (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('bridge','pair','session','link','action','event','notification')),
  record_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,kind,record_key)
);
CREATE INDEX browser_sessions_recent ON plugin_browser_sessions_d326bfce08.records(company_id,kind,created_at DESC);
CREATE INDEX browser_sessions_payload ON plugin_browser_sessions_d326bfce08.records USING gin(payload);
