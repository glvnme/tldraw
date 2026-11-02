// Stands in for `@clerk/clerk-react` when VITE_LOCAL_DEV_AUTH=1 (see vite.config.ts and
// apps/dotcom/README.md): one fixed, always signed-in user and the fixed token the sync worker
// accepts in local dev auth mode (LOCAL_DEV_USER in sync-worker's getAuth.ts). Covers only the
// Clerk API this app uses; add to it when a new call site needs more.
import { ReactNode } from 'react'

const USER_ID = 'local-dev-user-id'
const TOKEN = 'local-dev-token'

// Clerk keeps its session token in this cookie, and requests that carry no bearer header (feature
// flags, for one) authenticate with it through the /api proxy.
document.cookie = `__session=${TOKEN}; path=/; SameSite=Lax`

const user = {
	id: USER_ID,
	fullName: 'Local dev',
	firstName: 'Local',
	lastName: 'dev',
	imageUrl: '',
	hasImage: false,
	createdAt: new Date(0),
	primaryEmailAddress: {
		emailAddress: 'dev@localhost',
		verification: { status: 'verified' },
	},
	emailAddresses: [{ emailAddress: 'dev@localhost' }],
	externalAccounts: [],
	// Accepted already, so the legal terms dialog never opens.
	legalAcceptedAt: new Date(0),
	unsafeMetadata: {},
	publicMetadata: {},
	update: async () => user,
	reload: async () => user,
}

const signOut = async () => {
	window.location.reload()
}

const auth = {
	isLoaded: true,
	isSignedIn: true,
	userId: USER_ID,
	sessionId: 'local-dev-session',
	getToken: async () => TOKEN,
	signOut,
}

const clerk = {
	loaded: true,
	user,
	signOut,
	buildSignInUrl: () => '/',
	setActive: async () => {},
	client: {},
}

export function ClerkProvider({ children }: { children: ReactNode }) {
	return <>{children}</>
}

export function useAuth() {
	return auth
}

export function useUser() {
	return { isLoaded: true, isSignedIn: true, user }
}

export function useClerk() {
	return clerk
}

export function useSignIn() {
	return { isLoaded: false, signIn: undefined, setActive: clerk.setActive }
}
