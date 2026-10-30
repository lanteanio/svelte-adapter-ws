// Answers the auth endpoint with the number of body bytes it read, so a suite
// can tell which path served the request and that the body arrived whole.
export async function authenticate({ request }) {
	return new Response(String((await request.arrayBuffer()).byteLength));
}
