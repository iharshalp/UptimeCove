export type MonitorType = 'http' | 'tls_expiry' | 'dns' | 'tcp' | 'heartbeat' | 'synthetic' | 'browser' | 'multi_step';

export interface Monitor {
	id: number;
	slug: string;
	name: string;
	url: string;
	method: string;
	expected_status: number;
	interval_seconds: number;
	timeout_ms: number;
	enabled: number;
	current_status: 'up' | 'down' | 'paused' | 'pending';
	consecutive_failures: number;
	last_checked_at: number | null;
	next_check_at: number;
	check_claimed_until: number | null;
	check_claim_token: string | null;
	created_at: number;
	body_must_contain: string | null;
	body_must_not_contain: string | null;
	max_response_time_ms: number | null;
	custom_headers: string | null;
  check_regions: string | null;
  monitor_type?: MonitorType;
  dns_record_type?: string | null;
  dns_expected_value: string | null;
  tls_days_threshold?: number | null;
  tls_expiry_threshold_days?: number | null;
  steps?: string | null;
  synthetic_steps?: string | null;
  tcp_host?: string | null;
  tcp_port?: number | null;
}

export interface Check {
	id: number;
	monitor_id: number;
	ok: number;
	status_code: number | null;
	response_time_ms: number | null;
	error: string | null;
	checked_at: number;
	region: string | null;
	monitor_type: MonitorType | string | null;
}

export interface Incident {
	id: number;
	monitor_id: number;
	cause: string;
	started_at: number;
	resolved_at: number | null;
}

export interface IncidentUpdate {
	id: number;
	incident_id: number;
	message: string;
	author: string | null;
	created_at: number;
}

export interface MaintenanceWindow {
	id: number;
	title: string;
	description: string | null;
	monitor_id: number | null;
	status_page_id: number | null;
	start_at: number;
	end_at: number;
	enabled: number;
	created_at: number;
}

export interface StatusPage {
	id: number;
	slug: string;
	title: string;
	description: string | null;
	branding_logo_url: string | null;
	branding_theme: string | null;
	custom_domain: string | null;
	is_public: number;
	created_at: number;
}

export interface NotificationChannel {
	id: number;
	name: string;
	type: 'email' | 'webhook' | 'slack' | 'discord';
	config: string;
	enabled: number;
	created_at: number;
}

export interface NotificationDelivery {
	id: number;
	channel_id: number;
	incident_id: number | null;
	monitor_id: number | null;
	event: string;
	payload: string | null;
	status: string;
	error: string | null;
	created_at: number;
}

export interface HeartbeatMonitor {
	id: number;
	monitor_id: number;
	grace_seconds: number;
	last_ping_at: number | null;
}

export interface HeartbeatMonitorWithMonitor extends HeartbeatMonitor {
	monitor_name: string;
	monitor_url: string;
	monitor_slug: string;
	current_status: Monitor['current_status'];
	enabled: number;
}

export interface OnCallSchedule {
	id: string;
	name: string;
	timezone: string;
	rotation: string;
	members: string;
	created_at: number;
}

export interface EscalationPolicy {
	id: string;
	name: string;
	schedule_id: string | null;
	levels: string;
	created_at: number;
}

export interface IncidentPostmortem {
	id: string;
	incident_id: number;
	title: string;
	summary: string | null;
	timeline: string | null;
	action_items: string | null;
	author: string | null;
	ai_generated: number;
	created_at: number;
	updated_at: number;
}
