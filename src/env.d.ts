/// <reference path="../.astro/types.d.ts" />
declare global {
	namespace App {
		interface Locals {
			isAdmin: boolean;
			actor?: string | null;
			apiKey?: { id: string; name: string; scopes: string } | null;
		}
	}
}

export {};
