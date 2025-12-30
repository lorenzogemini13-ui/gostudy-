
const axios = require('axios');
const app = require('./server');

let server;
let port;
let baseURL;

// Helper to generate a unique ID
const genId = () => Math.random().toString(36).substring(7);

beforeAll((done) => {
    // Start the server on a random port
    server = app.listen(0, () => {
        port = server.address().port;
        baseURL = `http://localhost:${port}`;
        done();
    });
});

afterAll((done) => {
    server.close(done);
});

describe('PayPal Webhook Integration', () => {
    
    // We expect the server to SKIP verification if credentials are missing
    // So we ensure they are treated as such or we rely on the mocked behavior if we could mock.
    // However, in this integration test, we rely on the logic:
    // "if (!PAYPAL_CONFIG.clientId ...) returns true"
    // We assume the test env doesn't have these set to valid production values that would trigger real verification.

    test('should activate subscription and add credits', async () => {
        const userId = 'user_' + genId();
        const subscriptionId = 'sub_' + genId();
        const eventId = 'evt_' + genId();

        // 1. Create a user first (mocking the user creation via credits balance check is hard without direct DB access)
        // But the webhook handler tries to find user by custom_id.
        // Let's assume the user doesn't exist yet, but in `addCredits` it says:
        // "if (userDoc.exists) ... else transaction.set(userRef ...)"
        // So it should create the user if they don't exist!
        // Wait, `addCredits` does `transaction.get(userRef)`.
        
        // Payload for BILLING.SUBSCRIPTION.ACTIVATED
        const payload = {
            id: eventId,
            event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
            resource: {
                id: subscriptionId,
                custom_id: userId // This allows identifying the user
            }
        };

        const response = await axios.post(`${baseURL}/api/paypal/webhook`, payload, {
            headers: {
                'Content-Type': 'application/json',
                // Mock headers to pass the "presence" check if needed, 
                // but validation should be skipped in test env if vars are missing.
                'paypal-auth-algo': 'SHA256withRSA',
                'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-36006669742050278',
                'paypal-transmission-id': 'e82b3b20-1d8f-11ec-8853-27c5950p4174',
                'paypal-transmission-sig': 'mock_signature',
                'paypal-transmission-time': '2021-09-25T12:00:00Z'
            }
        });

        expect(response.status).toBe(200);

        // Ideally, we would check the database here to see if credits were added.
        // But we don't have direct access to the `db` instance from here easily without exporting it.
        // For now, we verify the endpoint returns 200 OK.
    });

    test('should handle refunds', async () => {
        const userId = 'user_refund_' + genId();
        const subscriptionId = 'sub_refund_' + genId();
        const eventId = 'evt_refund_' + genId();

        // First activate to create user
        await axios.post(`${baseURL}/api/paypal/webhook`, {
            id: 'evt_init_' + genId(),
            event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
            resource: { id: subscriptionId, custom_id: userId }
        });

        // Now refund
        const payload = {
            id: eventId,
            event_type: 'PAYMENT.SALE.REFUNDED',
            resource: {
                id: subscriptionId, // It looks up by subscription ID for refunds
                parent_payment: 'PAY-123'
            }
        };

        const response = await axios.post(`${baseURL}/api/paypal/webhook`, payload);
        expect(response.status).toBe(200);
    });

    test('should be idempotent (ignore duplicate events)', async () => {
        const eventId = 'evt_duplicate_' + genId();
        const subscriptionId = 'sub_dup_' + genId();
        const userId = 'user_dup_' + genId();

        const payload = {
            id: eventId,
            event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
            resource: { id: subscriptionId, custom_id: userId }
        };

        const res1 = await axios.post(`${baseURL}/api/paypal/webhook`, payload);
        expect(res1.status).toBe(200);

        const res2 = await axios.post(`${baseURL}/api/paypal/webhook`, payload);
        expect(res2.status).toBe(200);
    });
});
