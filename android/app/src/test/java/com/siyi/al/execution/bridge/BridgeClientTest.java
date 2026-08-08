package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.AuthorityIdentity;
import com.siyi.al.execution.BridgeAuthority;
import com.siyi.al.execution.LifecycleControl;
import com.siyi.al.execution.LifecycleControlCodec;
import com.siyi.al.execution.LifecycleControlSender;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class BridgeClientTest {
    @Test public void lanSignatureMatchesThePcRuntimeProtocol() throws Exception {
        assertEquals(
            "a691a19665109ef88332e8ee1cba83dbd6f5eaad0248a76090e06394732e0e06",
            BridgeClient.signLanRequest("pairing-secret-123", "POST", "/v1/turns", 1784400000000L, "nonce123", "{}")
        );
    }

    @Test public void legacyUserTextBecomesTheCanonicalWireMessage() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "turn_phone_9", "yuqi", "msg_phone_9", TurnKind.DIRECT_REPLY,
            "{\"userText\":\"你好 我是姜隽侑\",\"options\":{}}", "{}", null, 1784400000000L
        );
        Method method = BridgeClient.class.getDeclaredMethod("wireEnvelope", TurnSubmission.class);
        method.setAccessible(true);
        JSONObject envelope = (JSONObject) method.invoke(new BridgeClient(BridgeConfig.disabled()), submission);
        assertEquals("你好 我是姜隽侑", envelope.getJSONObject("message").getString("content"));
    }

    @Test public void lifecycleLanRouteUsesOnlyTheIndependentConversationClearEndpoint() throws Exception {
        FakeTransport transport = new FakeTransport();
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null, transport, () -> 1784400000000L,
            millis -> {}, null
        );
        LifecycleControl clear = clearControl(LifecycleControl.WAITING, null, null, null, null);
        transport.responses.add(new BridgeClient.HttpResult(200,
            LifecycleControlSender.encodeAppliedAck(clear, 1784400000100L).toString()));

        LifecycleControlSender.ControlDelivery delivery = client.lifecycleControlRoute(false)
            .send(clear, "relay-ignored", "idem-ignored", 1784400000000L + 86_400_000L);

        assertTrue(delivery.applied);
        assertEquals(1, transport.targets.size());
        assertEquals("http://lan.example/v3/controls/conversation-clear", transport.targets.get(0));
        assertFalse(transport.bodies.get(0).contains("turnId"));
        assertFalse(transport.bodies.get(0).contains("reply_json"));
    }

    @Test public void lifecycleLanRouteRejectsA200WithoutTheAppliedProof() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(200, "{}"));
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null, transport, () -> 1784400000000L,
            millis -> {}, null
        );
        LifecycleControl clear = clearControl(LifecycleControl.WAITING, null, null, null, null);
        assertThrows(IllegalArgumentException.class, () -> client.lifecycleControlRoute(false)
            .send(clear, "relay-inbound", "idem", 1784400000000L + 86_400_000L));
    }

    @Test public void lifecycleCloudRefreshUsesRefreshExpiryWithoutReencryptingOrEnqueueing() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(200,
            "{\"ok\":true,\"messageId\":\""
                + LifecycleControlSender.relayMessageId(clearControl(LifecycleControl.WAITING, null, null, null, null))
                + "\",\"expiresAt\":1784486400000,\"idempotent\":true}"));
        BridgeClient client = new BridgeClient(
            cloudConfig(), null, transport, () -> 1784400000000L,
            millis -> {}, null
        );
        LifecycleControl accepted = clearControl(
            LifecycleControl.RELAY_ACCEPTED,
            "lease-1", 1784400000000L - 10_000L,
            LifecycleControlSender.relayMessageId(clearControl(LifecycleControl.WAITING, null, null, null, null)),
            1784400000000L + 1_000L
        );

        LifecycleControlSender.ControlDelivery delivery = client.lifecycleControlRoute(true)
            .send(accepted, accepted.relayMessageId, LifecycleControlSender.idempotencyKey(accepted),
                1784400000000L + 86_400_000L);

        assertFalse(delivery.applied);
        assertEquals(1, transport.targets.size());
        assertTrue(transport.targets.get(0).endsWith("/bridge/refresh-expiry"));
        assertFalse(transport.bodies.get(0).contains("ciphertext"));
        assertFalse(transport.bodies.get(0).contains("nonce"));
    }

    @Test public void lifecycleCloudRefreshRejectsForeignMessageOrFalseOk() throws Exception {
        LifecycleControl accepted = clearControl(
            LifecycleControl.RELAY_ACCEPTED, "lease-1", 1784400000000L - 10_000L,
            LifecycleControlSender.relayMessageId(clearControl(LifecycleControl.WAITING, null, null, null, null)),
            1784486400000L);
        for (String body : new String[] {
            "{\"ok\":false,\"messageId\":\"" + accepted.relayMessageId
                + "\",\"expiresAt\":1784486400001,\"idempotent\":false}",
            "{\"ok\":true,\"messageId\":\"foreign\",\"expiresAt\":1784486400001,\"idempotent\":true}",
            "{\"ok\":true,\"messageId\":\"" + accepted.relayMessageId
                + "\",\"expiresAt\":\"1784486400001\",\"idempotent\":true}"
        }) {
            FakeTransport transport = new FakeTransport();
            transport.responses.add(new BridgeClient.HttpResult(200, body));
            BridgeClient client = lifecycleCloudClient(transport);
            assertThrows(IllegalArgumentException.class, () -> client.lifecycleControlRoute(true)
                .send(accepted, accepted.relayMessageId,
                    LifecycleControlSender.idempotencyKey(accepted),
                    1784400000000L + 86_400_000L));
        }
    }

    @Test public void lifecycleCloudRefreshExactReplayMayReturnPersistedExpiryAtSameMillisecond()
        throws Exception {
        LifecycleControl accepted = clearControl(
            LifecycleControl.RELAY_ACCEPTED, "lease-1", 1784400000000L - 10_000L,
            LifecycleControlSender.relayMessageId(clearControl(
                LifecycleControl.WAITING, null, null, null, null)),
            1784486400000L);
        String messageId = accepted.relayMessageId;
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(200,
            "{\"ok\":true,\"messageId\":\"" + messageId
                + "\",\"expiresAt\":1784486400000,\"idempotent\":true}"));
        BridgeClient client = lifecycleCloudClient(transport);

        LifecycleControlSender.ControlDelivery delivery = client.lifecycleControlRoute(true).send(
            accepted, messageId, LifecycleControlSender.idempotencyKey(accepted),
            1784486400001L);

        assertFalse(delivery.applied);
        assertEquals(1784486400000L, delivery.relayExpiresAt);
        assertEquals(1, transport.targets.size());
    }

    @Test public void lifecycleCloudInitialRequiresStableAcceptedResponse() throws Exception {
        LifecycleControl clear = clearControl(LifecycleControl.WAITING, null, null, null, null);
        for (String body : new String[] {
            "{\"ok\":false,\"messageId\":\"" + LifecycleControlSender.relayMessageId(clear) + "\",\"idempotent\":true}",
            "{\"ok\":true,\"messageId\":\"foreign\",\"idempotent\":true}",
            "{\"ok\":true,\"messageId\":\"" + LifecycleControlSender.relayMessageId(clear) + "\",\"idempotent\":\"true\"}"
        }) {
            FakeTransport transport = new FakeTransport();
            transport.responses.add(new BridgeClient.HttpResult(200, body));
            BridgeClient client = lifecycleCloudClient(transport);
            assertThrows(IllegalArgumentException.class, () -> client.lifecycleControlRoute(true)
                .send(clear, LifecycleControlSender.relayMessageId(clear),
                    LifecycleControlSender.idempotencyKey(clear),
                    1784400000000L + 86_400_000L));
        }
    }

    @Test public void lifecycleInitialEnqueueUsesDeterministicCiphertextAndNonce() throws Exception {
        LifecycleControl clear = clearControl(LifecycleControl.WAITING, null, null, null, null);
        String messageId = LifecycleControlSender.relayMessageId(clear);
        String response = "{\"ok\":true,\"messageId\":\"" + messageId
            + "\",\"idempotent\":false}";
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(200, response));
        transport.responses.add(new BridgeClient.HttpResult(200, response));
        BridgeClient client = lifecycleCloudClient(transport);
        client.lifecycleControlRoute(true).send(
            clear, messageId, LifecycleControlSender.idempotencyKey(clear),
            1784400000000L + 86_400_000L);
        client.lifecycleControlRoute(true).send(
            clear, messageId, LifecycleControlSender.idempotencyKey(clear),
            1784400000000L + 86_400_000L);
        JSONObject first = new JSONObject(transport.bodies.get(0));
        JSONObject second = new JSONObject(transport.bodies.get(1));
        assertEquals(first.getString("ciphertext"), second.getString("ciphertext"));
        assertEquals(first.getString("nonce"), second.getString("nonce"));
    }

    @Test public void idempotentInitialEnqueueRefreshesAndUsesServerExpiry() throws Exception {
        LifecycleControl clear = clearControl(LifecycleControl.WAITING, null, null, null, null);
        String messageId = LifecycleControlSender.relayMessageId(clear);
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(200,
            "{\"ok\":true,\"messageId\":\"" + messageId + "\",\"idempotent\":true}"));
        transport.responses.add(new BridgeClient.HttpResult(200,
            "{\"ok\":true,\"messageId\":\"" + messageId
                + "\",\"expiresAt\":1784572800000,\"idempotent\":true}"));
        BridgeClient client = lifecycleCloudClient(transport);
        LifecycleControlSender.ControlDelivery delivery = client.lifecycleControlRoute(true).send(
            clear, messageId, LifecycleControlSender.idempotencyKey(clear),
            1784400000000L + 86_400_000L);
        assertEquals(1784572800000L, delivery.relayExpiresAt);
        assertEquals(2, transport.targets.size());
        assertTrue(transport.targets.get(1).endsWith("/bridge/refresh-expiry"));
    }

    @Test public void cloudAppliedAckValidatesInnerEightFieldsBeforeRelayAck() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(200, "{}"));
        List<String> appliedBodies = new ArrayList<>();
        BridgeClient.CloudInboxConsumer consumer = new BridgeClient.CloudInboxConsumer() {
            @Override public boolean persist(String raw) { return false; }
            @Override public boolean applyLifecycleControl(
                String raw, String relayMessageId, Long relayExpiresAt, long now
            ) {
                appliedBodies.add(raw);
                assertEquals("inbound-applied-relay", relayMessageId);
                return true;
            }
        };
        BridgeClient client = new BridgeClient(
            cloudConfig(), null, transport, () -> 1784400000000L,
            millis -> {}, null, consumer
        );
        LifecycleControl clear = clearControl(LifecycleControl.RELAY_ACCEPTED,
            "lease-1", 1784399990000L,
            LifecycleControlSender.relayMessageId(clearControl(LifecycleControl.WAITING, null, null, null, null)),
            1784486400000L);
        JSONObject wrapper = LifecycleControlSender.encodeAppliedAck(clear, 1784400000100L);

        assertTrue(client.processDecodedCloudInboxItem(
            new JSONObject().put("messageId", "inbound-applied-relay").put("expiresAt", clear.relayExpiresAt),
            wrapper));
        assertEquals(1, appliedBodies.size());
        assertEquals(10, new JSONObject(appliedBodies.get(0)).length());
        assertEquals("ack", transport.targets.get(0).endsWith("/bridge/ack") ? "ack" : "wrong");
    }

    @Test public void ackExclusiveControlChecksumRoutesChangedTypeToLifecycleConsumer() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(200, "{}"));
        int[] applyCalls = {0};
        BridgeClient.CloudInboxConsumer consumer = new BridgeClient.CloudInboxConsumer() {
            @Override public boolean persist(String raw) {
                throw new AssertionError("changed lifecycle ACK must not enter generic persist");
            }
            @Override public boolean applyLifecycleControl(
                String raw, String relayMessageId, Long relayExpiresAt, long now
            ) {
                applyCalls[0] += 1;
                return false; // known conflict is never ACKed
            }
        };
        BridgeClient client = new BridgeClient(
            cloudConfig(), null, transport, () -> 1784400000000L,
            millis -> {}, null, consumer
        );
        LifecycleControl clear = clearControl(LifecycleControl.RELAY_ACCEPTED,
            "lease-1", 1784399990000L,
            LifecycleControlSender.relayMessageId(clearControl(LifecycleControl.WAITING, null, null, null, null)),
            1784486400000L);
        JSONObject changed = LifecycleControlSender.encodeAppliedAck(clear, 1784400000100L)
            .put("type", "WRONG_TYPE");
        assertFalse(client.processDecodedCloudInboxItem(
            new JSONObject().put("messageId", "inbound-changed")
                .put("expiresAt", clear.relayExpiresAt), changed));
        assertEquals(1, applyCalls[0]);
        assertTrue(transport.targets.isEmpty());
    }

    @Test public void lifecycleExclusiveFieldsCannotFallIntoGenericV3PersistWhenMarkersAreRemoved()
        throws Exception {
        LifecycleControl clear = clearControl(LifecycleControl.RELAY_ACCEPTED,
            "lease-1", 1784399990000L,
            LifecycleControlSender.relayMessageId(clearControl(LifecycleControl.WAITING, null, null, null, null)),
            1784486400000L);
        JSONObject valid = LifecycleControlSender.encodeAppliedAck(clear, 1784400000100L);
        JSONObject removedMarkers = new JSONObject(valid.toString());
        removedMarkers.remove("type");
        removedMarkers.remove("controlChecksum");
        JSONObject forgedType = new JSONObject(valid.toString()).put(
            "type", "NOT_CONVERSATION_CLEAR_APPLIED");
        forgedType.remove("controlChecksum");
        for (JSONObject malformed : new JSONObject[] {removedMarkers, forgedType}) {
            FakeTransport transport = new FakeTransport();
            transport.responses.add(new BridgeClient.HttpResult(200, "{}"));
            int[] applyCalls = {0};
            BridgeClient.CloudInboxConsumer consumer = new BridgeClient.CloudInboxConsumer() {
                @Override public boolean persist(String raw) {
                    throw new AssertionError("lifecycle-exclusive fields must not enter generic persist");
                }
                @Override public boolean applyLifecycleControl(
                    String raw, String relayMessageId, Long relayExpiresAt, long now
                ) {
                    applyCalls[0] += 1;
                    return false;
                }
            };
            BridgeClient client = new BridgeClient(
                cloudConfig(), null, transport, () -> 1784400000000L,
                millis -> {}, null, consumer
            );

            assertFalse(client.processDecodedCloudInboxItem(
                new JSONObject().put("messageId", "inbound-malformed-lifecycle")
                    .put("expiresAt", clear.relayExpiresAt), malformed));
            assertEquals(1, applyCalls[0]);
            assertTrue(transport.targets.isEmpty());
        }
    }

    @Test public void legacyPaymentMessageIdGetsACanonicalWirePrefix() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "turn_pay_1784713105609_3qb4xo", "yuqi", "pay_1784713105609_3qb4xo", TurnKind.DIRECT_REPLY,
            "{\"message\":{\"messageId\":\"pay_1784713105609_3qb4xo\",\"content\":\"姜隽倚给虞栖发了一个红包：¥20.00\",\"sentAt\":1784713105609},\"deviceSeq\":1784713105609}",
            "{}", null, 1784713105609L
        );

        JSONObject envelope = BridgeInput.envelope(submission, config("http://lan.example"));

        assertEquals("msg_pay_1784713105609_3qb4xo", envelope.getJSONObject("message").getString("messageId"));
    }

    @Test public void directPaymentPreservesStructuredPendingStateForThePcRuntime() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "turn_pay_1784713105609_3qb4xo", "yuqi", "pay_1784713105609_3qb4xo", TurnKind.DIRECT_REPLY,
            "{\"message\":{\"messageId\":\"pay_1784713105609_3qb4xo\",\"content\":\"红包\",\"sentAt\":1784713105609},"
                + "\"options\":{\"paymentMessageId\":\"pay_1784713105609_3qb4xo\","
                + "\"payment\":{\"kind\":\"redpacket\",\"amount\":20,\"note\":\"请你喝一杯\",\"status\":\"pending\"}}}",
            "{}", null, 1784713105609L
        );

        JSONObject payment = BridgeInput.envelope(submission, config("http://lan.example"))
            .getJSONObject("context").getJSONObject("payment");

        assertEquals("redpacket", payment.getString("kind"));
        assertEquals(20.0, payment.getDouble("amount"), 0.001);
        assertEquals("请你喝一杯", payment.getString("note"));
        assertEquals("pay_1784713105609_3qb4xo", payment.getString("messageId"));
        assertEquals("pending", payment.getString("status"));
    }

    @Test public void directTurnPreservesTheDynamicRelationshipSceneForThePcRuntime() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "turn_phone_scene_1", "yuqi", "msg_phone_scene_1", TurnKind.DIRECT_REPLY,
            "{\"message\":{\"messageId\":\"msg_phone_scene_1\",\"content\":\"在吗\",\"sentAt\":1784713105609}}",
            "{\"scene\":{\"playerName\":\"姜隽倚\",\"characterName\":\"虞栖\","
                + "\"relationshipStage\":{\"id\":\"familiar\",\"label\":\"熟悉\",\"content\":\"稳定联系\"},"
                + "\"conversationExtraPrompt\":\"今天很忙\"}}", null, 1784713105609L
        );

        JSONObject scene = BridgeInput.envelope(submission, config("http://lan.example"))
            .getJSONObject("context").getJSONObject("scene");

        assertEquals("姜隽倚", scene.getString("playerName"));
        assertEquals("familiar", scene.getJSONObject("relationshipStage").getString("id"));
        assertEquals("今天很忙", scene.getString("conversationExtraPrompt"));
    }

    @Test public void directTurnCarriesTheWholeCurrentMessageBatchBoundary() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "turn_phone_batch_1", "yuqi", "msg_batch_2", TurnKind.DIRECT_REPLY,
            "{\"message\":{\"messageId\":\"msg_batch_2\",\"content\":\"现在回来了\",\"sentAt\":1784787600000},"
                + "\"options\":{\"batchId\":\"batch_1\",\"batchMessageIds\":[\"msg_batch_1\",\"msg_batch_2\"]}}",
            "{}", null, 1784787605000L
        );

        JSONObject currentBatch = BridgeInput.envelope(submission, config("http://lan.example"))
            .getJSONObject("context").getJSONObject("currentBatch");

        assertEquals("batch_1", currentBatch.getString("batchId"));
        assertEquals(2, currentBatch.getJSONArray("messageIds").length());
        assertEquals("msg_batch_1", currentBatch.getJSONArray("messageIds").getString(0));
        assertEquals(1784787600000L, currentBatch.getLong("startedAt"));
        assertEquals(1784787605000L, currentBatch.getLong("committedAt"));
    }

    @Test public void proactiveEnvelopeContainsATriggerAndNeverFabricatesAUserMessage() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "turn_proactive_1", "yuqi", "trigger_proactive_1", TurnKind.PROACTIVE_CHAT,
            "{\"reason\":\"scheduled\",\"scheduledFor\":1784400000000}",
            "{\"relationshipStage\":\"initial\"}", "job_1", 1784400000100L
        );
        JSONObject envelope = BridgeInput.envelope(submission, config("http://lan.example"));
        assertEquals(2, envelope.getInt("protocolVersion"));
        assertFalse(envelope.has("message"));
        assertEquals("trigger_proactive_1", envelope.getJSONObject("trigger").getString("triggerId"));
        assertEquals("proactive_chat", envelope.getJSONObject("trigger").getString("triggerType"));
        assertEquals("initial", envelope.getJSONObject("trigger").getJSONObject("context")
            .getJSONObject("snapshot").getString("relationshipStage"));
    }

    @Test public void legacyInternalAutomaticIdGetsAProtocolSafeTurnPrefix() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "cloud_proactive_job_1", "yuqi", "trigger_proactive_1", TurnKind.PROACTIVE_CHAT,
            "{\"scheduledFor\":1784400000000}", "{}", "job_1", 1784400000100L
        );

        JSONObject envelope = BridgeInput.envelope(submission, config("http://lan.example"));

        assertEquals("turn_cloud_proactive_job_1", envelope.getString("turnId"));
    }

    @Test public void cloudProactiveMatchesTheCanonicalWireTurnId() throws Exception {
        TurnSubmission submission = new TurnSubmission(
            "cloud_proactive_job_1", "yuqi", "trigger_proactive_1", TurnKind.PROACTIVE_CHAT,
            "{\"scheduledFor\":1784400000000}", "{}", "job_1", 1784400000000L
        );

        assertTrue(BridgeClient.matchesTurn(submission, "turn_cloud_proactive_job_1"));
        assertFalse(BridgeClient.matchesTurn(submission, "turn_cloud_some_other_job"));
    }

    @Test public void oldCommittedCloudResultIsCollectedEvenWhenAnotherTurnIsActive() throws Exception {
        TurnSubmission current = new TurnSubmission(
            "cloud_proactive_job_new", "yuqi", "trigger_proactive_new", TurnKind.PROACTIVE_CHAT,
            "{}", "{}", "job_new", 1784400000000L
        );
        JSONObject old = new JSONObject()
            .put("turnId", "turn_cloud_proactive_job_old")
            .put("state", "committed")
            .put("terminal", true)
            .put("reply", new JSONObject().put("messageId", "msg_yuqi_old").put("content", "旧消息"));

        assertEquals("BACKLOG_COMMITTED", BridgeClient.classifyCloudResult(current, old));
        assertEquals("CURRENT_COMMITTED", BridgeClient.classifyCloudResult(
            current,
            new JSONObject(old.toString()).put("turnId", "turn_cloud_proactive_job_new")
        ));
    }

    @Test public void backlogFailureMustBePersistedBeforeItIsAcknowledged() throws Exception {
        List<String> persisted = new ArrayList<>();
        String raw = "{\"turnId\":\"turn_phone_old\",\"state\":\"failed\",\"terminal\":true,"
            + "\"errorCode\":\"INTERNAL_PRIVATE_CODE\"}";

        boolean saved = BridgeClient.persistBacklogFailure(value -> {
            persisted.add(value);
            return true;
        }, raw);

        assertTrue(saved);
        assertEquals(1, persisted.size());
        assertEquals("turn_phone_old", new JSONObject(persisted.get(0)).getString("turnId"));
    }

    @Test public void canonicalCloudRelayIsAcknowledgedOnlyAfterRoomApplyAndNeverPublishesEarlyReceipt()
        throws Exception {
        List<String> events = new ArrayList<>();
        BridgeClient.Transport transport = (method, target, body, headers) -> {
            events.add(target.endsWith("/bridge/ack") ? "ack" : "unexpected:" + target);
            return new BridgeClient.HttpResult(200, "{}");
        };
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null, transport, () -> 500L, millis -> {}, null,
            raw -> {
                events.add("room");
                return true;
            }
        );
        JSONObject item = new JSONObject().put("messageId", "relay_v3_skip");

        assertTrue(client.processDecodedCloudInboxItem(item, canonicalSkipWire()));
        assertEquals(java.util.Arrays.asList("room", "ack"), events);
    }

    @Test public void canonicalCloudProofFailureLeavesRelayUnacknowledged() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null,
            (method, target, body, headers) -> {
                events.add("ack");
                return new BridgeClient.HttpResult(200, "{}");
            },
            () -> 500L,
            millis -> {},
            null,
            raw -> { throw new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT"); }
        );

        assertThrows(IllegalStateException.class, () -> client.processDecodedCloudInboxItem(
            new JSONObject().put("messageId", "relay_v3_invalid"), canonicalSkipWire()));
        assertTrue(events.isEmpty());
    }

    @Test public void malformedCanonicalProtocolVersionCannotFallBackToLegacyAck() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null,
            (method, target, body, headers) -> {
                events.add("ack");
                return new BridgeClient.HttpResult(200, "{}");
            },
            () -> 500L,
            millis -> {},
            null,
            raw -> {
                events.add("legacy-consumer");
                return true;
            }
        );
        JSONObject malformed = canonicalSkipWire().put("protocolVersion", "3");

        assertThrows(IllegalArgumentException.class, () -> client.processDecodedCloudInboxItem(
            new JSONObject().put("messageId", "relay_v3_malformed"), malformed));
        assertTrue(events.isEmpty());
    }

    @Test public void lanAcceptedTurnPollsWithFreshSignedGetsUntilCommitted() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(202,
            "{\"ok\":true,\"turnId\":\"turn_phone_1\",\"state\":\"queued\",\"terminal\":false,\"retryAfterMs\":1}"));
        transport.responses.add(new BridgeClient.HttpResult(200,
            "{\"ok\":true,\"turnId\":\"turn_phone_1\",\"state\":\"brain_running\",\"terminal\":false,\"retryAfterMs\":1}"));
        transport.responses.add(new BridgeClient.HttpResult(200,
            "{\"ok\":true,\"turnId\":\"turn_phone_1\",\"state\":\"committed\",\"terminal\":true,"
                + "\"reply\":{\"content\":\"你好呀\",\"origin\":\"codex\"},\"recoveryAckSeq\":0}"));
        MutableTime time = new MutableTime(1784400000000L);
        List<String> statuses = new ArrayList<>();
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null, transport, time, time,
            (turnId, raw) -> statuses.add(turnId + ":" + statusState(raw))
        );

        BridgeResult result = client.sendLan(directSubmission(1784400000000L));

        assertEquals("你好呀", result.replyText);
        assertEquals("codex", result.origin);
        assertEquals(3, transport.targets.size());
        assertTrue(transport.targets.get(0).endsWith("/v2/turns"));
        assertTrue(transport.targets.get(1).endsWith("/v2/turns/turn_phone_1"));
        assertTrue(transport.targets.get(2).endsWith("/v2/turns/turn_phone_1"));
        assertFalse(transport.nonces.get(1).equals(transport.nonces.get(2)));
        assertEquals(3, statuses.size());
        assertEquals("turn_phone_1:queued", statuses.get(0));
        assertEquals("turn_phone_1:committed", statuses.get(2));
    }

    @Test public void lanPreparedV3ImmediateTerminalUsesTheClosedAuthorityParser() throws Exception {
        String lineage = "lineage_lan_v3_immediate";
        String remoteTurnId = "turn_remote_lan_v3_immediate";
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(200,
            canonicalSkipWire(lineage, remoteTurnId)
                .put("terminal", true).put("recoveryAckSeq", 7L).toString()));
        BridgeClient client = receiptClient(transport, new MutableTime(1784400000000L));

        BridgeResult result = client.sendLan(canonicalV3Submission(
            "local_lan_v3_immediate", remoteTurnId, lineage, 1L));

        assertEquals(BridgeResult.Kind.CANONICAL_TERMINAL, result.kind);
        assertEquals(remoteTurnId, result.authoritativeTurnId);
        assertEquals("skip", result.terminalDisposition);
        assertEquals(1, transport.targets.size());
    }

    @Test public void lanPreparedV3PollAcceptsAnEarlierCommittedMember() throws Exception {
        String lineage = "lineage_lan_v3_retry";
        String childTurnId = "turn_remote_lan_v3_child";
        String parentTurnId = "turn_remote_lan_v3_parent";
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(202,
            "{\"ok\":true,\"turnId\":\"" + childTurnId
                + "\",\"state\":\"queued\",\"terminal\":false,\"retryAfterMs\":1}"));
        transport.responses.add(new BridgeClient.HttpResult(200,
            canonicalSkipWire(lineage, parentTurnId)
                .put("terminal", true).put("recoveryAckSeq", 8L).toString()));
        MutableTime time = new MutableTime(1784400000000L);
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null, transport, time, time, null);

        BridgeResult result = client.sendLan(canonicalV3Submission(
            "local_lan_v3_retry", childTurnId, lineage, 2L));

        assertEquals(BridgeResult.Kind.CANONICAL_TERMINAL, result.kind);
        assertEquals(parentTurnId, result.authoritativeTurnId);
        assertEquals(2, transport.targets.size());
    }

    @Test public void lanPreparedV3ReturnsVerifiedRemoteFailureInsteadOfLegacyFallback() throws Exception {
        String lineage = "lineage_lan_v3_failure";
        String remoteTurnId = "turn_remote_lan_v3_failure";
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(200,
            canonicalFailureWire(lineage, remoteTurnId, true).toString()));
        BridgeClient client = receiptClient(
            transport, new MutableTime(1784400000000L));

        BridgeResult result = client.sendLan(canonicalV3Submission(
            "local_lan_v3_failure", remoteTurnId, lineage, 1L));

        assertEquals(BridgeResult.Kind.VERIFIED_REMOTE_FAILURE, result.kind);
        assertEquals(remoteTurnId, result.authoritativeTurnId);
        assertTrue(result.retryAllowed);
    }

    @Test public void cloudCanonicalMarkersCannotDowngradeWhenProtocolVersionIsMissing() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null,
            (method, target, body, headers) -> {
                events.add("ack");
                return new BridgeClient.HttpResult(200, "{}");
            },
            () -> 500L,
            millis -> {},
            null,
            raw -> {
                events.add("consumer");
                return true;
            }
        );
        JSONObject downgraded = canonicalSkipWire();
        downgraded.remove("protocolVersion");
        downgraded.put("terminal", true).put("reply", new JSONObject()
            .put("messageId", "msg_downgrade")
            .put("content", "不应进入旧链路"));

        assertThrows(IllegalArgumentException.class, () -> client.processDecodedCloudInboxItem(
            new JSONObject().put("messageId", "relay_v3_downgrade"), downgraded));
        assertTrue(events.isEmpty());
    }

    @Test public void cloudPayloadCannotPredeclareReservedTransportMetadata() throws Exception {
        List<String> events = new ArrayList<>();
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null,
            (method, target, body, headers) -> {
                events.add("ack");
                return new BridgeClient.HttpResult(200, "{}");
            },
            () -> 500L,
            millis -> {},
            null,
            raw -> {
                events.add("consumer");
                return true;
            }
        );

        for (String reserved : new String[]{"_relayMessageId", "_deliveryRoute"}) {
            JSONObject payload = canonicalSkipWire().put(reserved, "attacker");
            assertThrows(IllegalArgumentException.class, () -> client.processDecodedCloudInboxItem(
                new JSONObject().put("messageId", "relay_v3_reserved_" + reserved), payload));
        }
        assertTrue(events.isEmpty());
    }

    @Test public void rejectedCanonicalCloudItemDoesNotAckOrStarveTheNextValidItem()
        throws Exception {
        List<String> events = new ArrayList<>();
        BridgeClient.CloudInboxConsumer consumer = new BridgeClient.CloudInboxConsumer() {
            @Override public boolean persist(String raw) throws Exception {
                events.add("persist:" + new JSONObject(raw).optString("_relayMessageId"));
                return true;
            }

            @Override public void recordRejected(String relayMessageId, String reason, long now) {
                events.add("reject:" + relayMessageId + ":" + reason);
            }
        };
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null,
            (method, target, body, headers) -> {
                if (target.endsWith("/bridge/ack")) {
                    events.add("ack:" + new JSONObject(body)
                        .getJSONArray("messageIds").getString(0));
                }
                return new BridgeClient.HttpResult(200, "{}");
            },
            () -> 500L, millis -> {}, null, consumer);
        JSONObject bad = canonicalSkipWire();
        bad.remove("protocolVersion");
        JSONArray batch = new JSONArray()
            .put(new JSONObject().put("messageId", "relay_bad")
                .put("decoded", bad))
            .put(new JSONObject().put("messageId", "relay_good")
                .put("decoded", canonicalSkipWire()));

        int processed = client.processCloudInboxBatch(
            batch, item -> item.getJSONObject("decoded"));

        assertEquals(1, processed);
        assertEquals(java.util.Arrays.asList(
            "reject:relay_bad:protocol_conflict",
            "persist:relay_good",
            "ack:relay_good"
        ), events);
    }

    @Test public void unknownCloudInboxProgramOrDatabaseErrorStillEscapesTheBatch()
        throws Exception {
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null,
            (method, target, body, headers) -> new BridgeClient.HttpResult(200, "{}"),
            () -> 500L, millis -> {}, null,
            raw -> { throw new IllegalStateException("SQLITE_BUSY"); });
        JSONArray batch = new JSONArray()
            .put(new JSONObject().put("messageId", "relay_unknown")
                .put("decoded", canonicalSkipWire()))
            .put(new JSONObject().put("messageId", "relay_never_reached")
                .put("decoded", canonicalSkipWire()));

        IllegalStateException error = assertThrows(IllegalStateException.class, () ->
            client.processCloudInboxBatch(batch, item -> item.getJSONObject("decoded")));
        assertEquals("SQLITE_BUSY", error.getMessage());
        assertFalse(BridgeClient.isCanonicalInboxRejection(error));
    }

    @Test public void canonicalLookingProgramErrorsAreNotClassifiedByTheirMessagePrefix()
        throws Exception {
        String[] messages = new String[] {
            "v3 bridge arbitrary programming fault",
            "canonical result arbitrary programming fault",
            "canonical failure arbitrary programming fault"
        };
        for (String message : messages) {
            List<String> events = new ArrayList<>();
            BridgeClient.CloudInboxConsumer consumer = new BridgeClient.CloudInboxConsumer() {
                @Override public boolean persist(String raw) {
                    throw new IllegalArgumentException(message);
                }

                @Override public void recordRejected(String relayMessageId, String reason, long now) {
                    events.add("reject");
                }
            };
            BridgeClient client = new BridgeClient(
                config("http://lan.example"), null,
                (method, target, body, headers) -> new BridgeClient.HttpResult(200, "{}"),
                () -> 500L, millis -> {}, null, consumer);
            JSONArray batch = new JSONArray().put(new JSONObject()
                .put("messageId", "relay_unknown_prefix")
                .put("decoded", canonicalSkipWire()));

            IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
                client.processCloudInboxBatch(batch, item -> item.getJSONObject("decoded")));

            assertEquals(message, error.getMessage());
            assertFalse(BridgeClient.isCanonicalInboxRejection(error));
            assertTrue(events.isEmpty());
        }
    }

    @Test public void aRealMalformedV3PayloadIsIsolatedAndTheNextItemStillCommits()
        throws Exception {
        List<String> events = new ArrayList<>();
        BridgeClient.CloudInboxConsumer consumer = new BridgeClient.CloudInboxConsumer() {
            @Override public boolean persist(String raw) throws Exception {
                JSONObject value = new JSONObject(raw);
                String relayMessageId = value.getString("_relayMessageId");
                value.remove("_relayMessageId");
                value.remove("_deliveryRoute");
                BridgeTurnStatus.parseV3(
                    value.toString(), "cloud", relayMessageId);
                events.add("persist:" + relayMessageId);
                return true;
            }

            @Override public void recordRejected(String relayMessageId, String reason, long now) {
                events.add("reject:" + relayMessageId + ":" + reason);
            }
        };
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null,
            (method, target, body, headers) -> {
                if (target.endsWith("/bridge/ack")) {
                    events.add("ack:" + new JSONObject(body)
                        .getJSONArray("messageIds").getString(0));
                }
                return new BridgeClient.HttpResult(200, "{}");
            },
            () -> 500L, millis -> {}, null, consumer);
        JSONObject bad = canonicalSkipWire().put("terminalDisposition", "not_a_disposition");
        JSONArray batch = new JSONArray()
            .put(new JSONObject().put("messageId", "relay_malformed")
                .put("decoded", bad))
            .put(new JSONObject().put("messageId", "relay_valid")
                .put("decoded", canonicalSkipWire()));

        int processed = client.processCloudInboxBatch(
            batch, item -> item.getJSONObject("decoded"));

        assertEquals(1, processed);
        assertEquals(java.util.Arrays.asList(
            "reject:relay_malformed:parse_conflict",
            "persist:relay_valid",
            "ack:relay_valid"
        ), events);
    }

    @Test public void cloudAcceptedTurnReleasesTheWorkerWithoutLongPolling() throws Exception {
        try {
            BridgeClient.completeCloudHandoff();
            throw new AssertionError("expected durable cloud handoff");
        } catch (BridgeAcceptedException accepted) {
            assertEquals("cloud", accepted.route());
        }
    }

    @Test public void bridgeStatusParsesRouteStageModelAndDurations() throws Exception {
        BridgeTurnStatus status = BridgeTurnStatus.parse(
            "{\"turnId\":\"turn_phone_1\",\"state\":\"memory_running\",\"terminal\":false,"
                + "\"route\":\"fast\",\"displayStage\":\"正在翻一下我们以前说过的话…\","
                + "\"technicalStage\":\"memory\",\"stageModel\":\"gpt-5.6-terra\","
                + "\"stageEffort\":\"medium\",\"stageElapsedMs\":600,\"totalElapsedMs\":800}",
            "turn_phone_1"
        );
        assertEquals("fast", status.route);
        assertEquals("正在翻一下我们以前说过的话…", status.displayStage);
        assertEquals("memory", status.technicalStage);
        assertEquals("gpt-5.6-terra", status.stageModel);
        assertEquals("medium", status.stageEffort);
        assertEquals(600L, status.stageElapsedMs);
        assertEquals(800L, status.totalElapsedMs);
    }

    @Test public void terminalSkipIsACommittedBridgeResultWithoutReplyText() throws Exception {
        BridgeTurnStatus status = BridgeTurnStatus.parse(
            "{\"turnId\":\"turn_phone_1\",\"state\":\"committed\",\"terminal\":true,\"action\":\"skip\",\"reply\":null}",
            "turn_phone_1"
        );
        assertTrue(status.skipped());
        assertFalse(status.failedFinal());
        BridgeResult result = status.toResult("cloud");
        assertTrue(result.skipped);
        assertEquals("", result.replyText);
    }

    @Test public void committedPaymentDecisionBecomesABridgePaymentStatus() throws Exception {
        BridgeTurnStatus status = BridgeTurnStatus.parse(
            "{\"turnId\":\"turn_phone_1\",\"state\":\"committed\",\"terminal\":true,"
                + "\"action\":\"send\",\"paymentAction\":\"received\","
                + "\"reply\":{\"content\":\"那我就收了\"}}",
            "turn_phone_1"
        );

        BridgeResult result = status.toResult("cloud");
        assertEquals("received", result.paymentStatus);
    }

    @Test public void canonicalAuthorityReceiptUsesTheV3GroupPathAndExactWireBytes() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(200, "{}"));
        BridgeClient client = new BridgeClient(
            config("http://lan.example"), null, transport,
            new MutableTime(1784400000000L), millis -> {}, null);
        JSONObject decoded = authorityReceiptWire(
            "turn_receipt_lan", "lineage_receipt_lan", "lan", null);
        JSONObject wire = receiptWireOnly(decoded);

        assertTrue(client.confirmAppliedResult(decoded.toString()));
        assertEquals(1, transport.targets.size());
        assertTrue(transport.targets.get(0).endsWith(
            "/v3/groups/" + AuthorityIdentity.groupId("lineage_receipt_lan") + "/delivery-receipt"));
        assertEquals(BridgeAuthority.canonicalJson(wire), transport.bodies.get(0));
    }

    @Test public void cloudReceiptEncryptsTheExistingAuthorityWireWithoutRebuildingIdentity() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(200, "{}"));
        transport.responses.add(new BridgeClient.HttpResult(200, "{}"));
        BridgeClient client = receiptClient(
            transport, new MutableTime(1784400000000L));
        JSONObject decoded = authorityReceiptWire("turn_receipt_cloud", "lineage_receipt_cloud");
        JSONObject wire = receiptWireOnly(decoded);

        assertTrue(client.confirmAppliedResult(decoded.toString()));
        assertEquals(2, transport.targets.size());
        JSONObject enqueue = new JSONObject(transport.bodies.get(0));
        assertEquals(
            BridgeAuthority.canonicalJson(wire),
            decrypt(enqueue.getString("ciphertext"), enqueue.getString("nonce")));
        assertEquals("relay_turn_receipt_cloud", new JSONObject(transport.bodies.get(1))
            .getJSONArray("messageIds").getString(0));
    }

    @Test public void skipReceiptSupportsZeroItemsAndRetryKeepsWireIdempotencyAndDeliveredAtStable() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.responses.add(new BridgeClient.HttpResult(500, "{}"));
        transport.responses.add(new BridgeClient.HttpResult(200, "{}"));
        transport.responses.add(new BridgeClient.HttpResult(200, "{}"));
        MutableTime time = new MutableTime(1784400000000L);
        BridgeClient client = receiptClient(transport, time);
        JSONObject decoded = authorityReceiptWire("turn_receipt_retry", "lineage_receipt_retry");

        try {
            client.confirmAppliedResult(decoded.toString());
        } catch (BridgePendingException expected) {
            // The remote may accept the retry later; the receipt identity must not change.
        }
        time.now += 90_000L;
        assertTrue(client.confirmAppliedResult(decoded.toString()));

        assertEquals(3, transport.targets.size());
        JSONObject first = new JSONObject(transport.bodies.get(0));
        JSONObject second = new JSONObject(transport.bodies.get(1));
        assertEquals(first.getString("idempotencyKey"), second.getString("idempotencyKey"));
        assertEquals(
            decrypt(first.getString("ciphertext"), first.getString("nonce")),
            decrypt(second.getString("ciphertext"), second.getString("nonce")));
        assertEquals(
            new JSONObject(decrypt(first.getString("ciphertext"), first.getString("nonce")))
                .getLong("deliveredAt"),
            new JSONObject(decrypt(second.getString("ciphertext"), second.getString("nonce")))
                .getLong("deliveredAt"));
    }

    @Test public void changedAuthorityIdentityIsRejectedBeforeAnySendOrAck() throws Exception {
        String[] changedWireFields = new String[] {
            "visibleGroupId", "commitChecksum", "peerId", "turnId"
        };
        for (String field : changedWireFields) {
            FakeTransport transport = new FakeTransport();
            transport.responses.add(new BridgeClient.HttpResult(200, "{}"));
            transport.responses.add(new BridgeClient.HttpResult(200, "{}"));
            BridgeClient client = receiptClient(
                transport, new MutableTime(1784400000000L));
            JSONObject valid = authorityReceiptWire("turn_changed_" + field, "lineage_changed_" + field);
            assertTrue(client.confirmAppliedResult(valid.toString()));
            int sendsBeforeMutation = transport.targets.size();

            JSONObject changed = new JSONObject(valid.toString());
            if ("visibleGroupId".equals(field)) changed.put(field, AuthorityIdentity.groupId("forged"));
            else if ("commitChecksum".equals(field)) changed.put(field, repeat('e', 64));
            else changed.put(field, "changed_" + field);
            try {
                client.confirmAppliedResult(changed.toString());
                throw new AssertionError(field + " must be rejected");
            } catch (IllegalArgumentException expected) {
                // Closed authority identity changes must never reach transport or ACK.
            }
            assertEquals(sendsBeforeMutation, transport.targets.size());
        }

        FakeTransport routeTransport = new FakeTransport();
        routeTransport.responses.add(new BridgeClient.HttpResult(200, "{}"));
        routeTransport.responses.add(new BridgeClient.HttpResult(200, "{}"));
        BridgeClient routeClient = receiptClient(
            routeTransport, new MutableTime(1784400000000L));
        JSONObject validRoute = authorityReceiptWire("turn_changed_route", "lineage_changed_route");
        assertTrue(routeClient.confirmAppliedResult(validRoute.toString()));
        int sendsBeforeRoute = routeTransport.targets.size();
        JSONObject changedRoute = new JSONObject(validRoute.toString()).put("_deliveryRoute", "lan");
        try {
            routeClient.confirmAppliedResult(changedRoute.toString());
            throw new AssertionError("route must be rejected");
        } catch (IllegalArgumentException expected) {
            // expected
        }
        assertEquals(sendsBeforeRoute, routeTransport.targets.size());
    }

    private static JSONObject authorityReceiptWire(String turnId, String lineage) throws Exception {
        return authorityReceiptWire(turnId, lineage, "cloud", "relay_" + turnId);
    }

    private static JSONObject authorityReceiptWire(
        String turnId, String lineage, String route, String relayMessageId
    ) throws Exception {
        JSONObject checkpoint = authorityV12Checkpoint(turnId, lineage, route, relayMessageId);
        JSONObject result = checkpoint.getJSONObject("outcome").getJSONObject("result");
        JSONObject outcome = checkpoint.getJSONObject("outcome");
        JSONObject receipt = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "AUTHORITY_DELIVERY_RECEIPT")
            .put("peerId", "device_123456")
            .put("turnId", result.getString("turnId"))
            .put("authorityLineageKey", result.getString("authorityLineageKey"))
            .put("visibleGroupId", result.getString("visibleGroupId"))
            .put("commitChecksum", result.getString("commitChecksum"))
            .put("terminalDisposition", result.getString("terminalDisposition"))
            .put("deliveredAt", 1784400000130L)
            .put("_checkpointChecksum", BridgeAuthority.sha256CanonicalJson(checkpoint));
        receipt.put("_deliveryRoute", outcome.getString("route"));
        if (outcome.isNull("relayMessageId")) {
            receipt.remove("_relayMessageId");
        } else {
            receipt.put("_relayMessageId", outcome.getString("relayMessageId"));
        }
        return receipt;
    }

    private static JSONObject receiptWireOnly(JSONObject decoded) throws Exception {
        JSONObject wire = new JSONObject(decoded.toString());
        wire.remove("_deliveryRoute");
        wire.remove("_relayMessageId");
        wire.remove("_checkpointChecksum");
        return wire;
    }

    private static JSONObject authorityV12Checkpoint(
        String turnId, String lineage, String route, String relayMessageId
    ) throws Exception {
        JSONObject result = new JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", turnId)
            .put("roleId", "yuqi")
            .put("authorityOrigin", "pc")
            .put("authorityLineageKey", lineage)
            .put("visibleGroupId", AuthorityIdentity.groupId(lineage))
            .put("lineageRevision", 1L)
            .put("turnRevision", 1L)
            .put("laneKey", "private_chat")
            .put("laneRevision", 1L)
            .put("inputVisibilitySequence", 1L)
            .put("inputClearEpoch", 0L)
            .put("generationFingerprint", JSONObject.NULL)
            .put("releaseId", "release_v3")
            .put("commitPayloadVersion", "pc-visible-commit-v2")
            .put("commitChecksum", repeat('a', 64))
            .put("terminalDisposition", "skip")
            .put("replyParts", new JSONArray())
            .put("actions", new JSONArray());
        JSONObject envelope = new JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", turnId)
            .put("characterId", "yuqi")
            .put("deviceId", "device_123456")
            .put("deviceSeq", 1L)
            .put("createdAt", 1784400000000L)
            .put("authority", new JSONObject()
                .put("lineageKey", lineage)
                .put("claimedLineageRevision", 1L)
                .put("laneKey", "private_chat")
                .put("retryOfTurnId", JSONObject.NULL));
        return new JSONObject()
            .put("version", 1L)
            .put("localTurnId", "local_" + turnId)
            .put("attemptId", "attempt_" + turnId)
            .put("attemptSequence", 1L)
            .put("authoritativeTurnId", turnId)
            .put("authorityLineageKey", lineage)
            .put("claimedLineageRevision", 1L)
            .put("retryOfTurnId", JSONObject.NULL)
            .put("laneKey", "private_chat")
            .put("inputVisibilitySequence", 1L)
            .put("inputClearEpoch", 0L)
            .put("normalizedEnvelope", envelope)
            .put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(envelope))
            .put("outcome", new JSONObject()
                .put("type", "committed")
                .put("route", route)
                .put("relayMessageId", relayMessageId == null ? JSONObject.NULL : relayMessageId)
                .put("failure", JSONObject.NULL)
                .put("result", result)
                .put("redactedAt", JSONObject.NULL));
    }

    private static String decrypt(String ciphertext, String nonce) throws Exception {
        byte[] key = Base64.getDecoder().decode("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
            new GCMParameterSpec(128, Base64.getDecoder().decode(nonce)));
        return new String(cipher.doFinal(Base64.getDecoder().decode(ciphertext)), StandardCharsets.UTF_8);
    }

    private static TurnSubmission directSubmission(long createdAt) {
        return new TurnSubmission(
            "turn_phone_1", "yuqi", "msg_phone_1", TurnKind.DIRECT_REPLY,
            "{\"userText\":\"你好\",\"deviceSeq\":1}", "{}", null, createdAt
        );
    }

    private static JSONObject canonicalSkipWire() throws Exception {
        return canonicalSkipWire("lineage_cloud_client", "turn_remote_cloud_client");
    }

    private static JSONObject canonicalSkipWire(String lineage, String remoteTurnId) throws Exception {
        return new JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", remoteTurnId)
            .put("roleId", "yuqi")
            .put("authorityOrigin", "pc")
            .put("authorityLineageKey", lineage)
            .put("visibleGroupId", AuthorityIdentity.groupId(lineage))
            .put("lineageRevision", 2L)
            .put("turnRevision", 1L)
            .put("laneKey", "private_chat")
            .put("laneRevision", 1L)
            .put("inputVisibilitySequence", 1L)
            .put("inputClearEpoch", 0L)
            .put("generationFingerprint", JSONObject.NULL)
            .put("releaseId", "release-cognition-v3")
            .put("commitPayloadVersion", "v3")
            .put("commitChecksum", repeat('a', 64))
            .put("terminalDisposition", "skip")
            .put("replyParts", new org.json.JSONArray())
            .put("actions", new org.json.JSONArray());
    }

    private static JSONObject canonicalFailureWire(
        String lineage, String remoteTurnId, boolean retryAllowed
    ) throws Exception {
        JSONObject wire = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "BACKLOG_FAILED")
            .put("turnId", remoteTurnId)
            .put("roleId", "yuqi")
            .put("authorityLineageKey", lineage)
            .put("lineageRevision", 1L)
            .put("turnRevision", 2L)
            .put("laneKey", "private_chat")
            .put("laneRevision", 1L)
            .put("retryOfTurnId", JSONObject.NULL)
            .put("inputVisibilitySequence", 1L)
            .put("inputClearEpoch", 0L)
            .put("generationFingerprint", JSONObject.NULL)
            .put("releaseId", "release-cognition-v3")
            .put("state", "failed")
            .put("errorCode", retryAllowed
                ? "YUQI_TRANSIENT_EXECUTION_FAILURE"
                : "YUQI_DETERMINISTIC_EXECUTION_FAILURE")
            .put("failureClass", retryAllowed ? "transient" : "deterministic")
            .put("retryAllowed", retryAllowed)
            .put("failedAt", 1784400000100L);
        wire.put("rawStatusChecksum", BridgeAuthority.sha256CanonicalJson(wire));
        return wire.put("terminal", true).put("recoveryAckSeq", 9L);
    }

    private static TurnSubmission canonicalV3Submission(
        String localTurnId, String remoteTurnId, String lineage, long claim
    ) throws Exception {
        long createdAt = 1784400000000L;
        String messageId = "msg_" + localTurnId;
        JSONObject message = new JSONObject()
            .put("messageId", messageId)
            .put("speakerId", "user")
            .put("speakerType", "user")
            .put("recipientId", "yuqi")
            .put("content", "你好")
            .put("sentAt", createdAt);
        JSONObject input = new JSONObject()
            .put("message", message)
            .put("options", new JSONObject()
                .put("batchId", "batch_" + localTurnId)
                .put("batchMessageIds", new JSONArray().put(messageId))
                .put("batchMessages", new JSONArray().put(message))
                .put("batchStartedAt", createdAt)
                .put("batchCommittedAt", createdAt));
        TurnSubmission base = new TurnSubmission(
            localTurnId, "yuqi", messageId, TurnKind.DIRECT_REPLY,
            input.toString(), "{}", null, createdAt);
        JSONObject cursor = new JSONObject()
            .put("nativeCompletedTurnId", JSONObject.NULL)
            .put("nativeCompletedGroupId", JSONObject.NULL)
            .put("nativeCompletedSequence", 0L)
            .put("uiAppliedTurnId", JSONObject.NULL)
            .put("uiAppliedGroupId", JSONObject.NULL)
            .put("uiAppliedSequence", 0L)
            .put("localSequence", 1L)
            .put("clearedThroughSequence", 0L)
            .put("clearEpoch", 0L);
        JSONObject envelope = BridgeInput.prepareV3Envelope(
            base, "device_123456", remoteTurnId, "private_chat", messageId,
            lineage, claim, null, cursor);
        JSONObject checkpoint = new JSONObject()
            .put("version", 1L)
            .put("localTurnId", localTurnId)
            .put("attemptId", "attempt_" + localTurnId + "_1")
            .put("attemptSequence", 1L)
            .put("authoritativeTurnId", remoteTurnId)
            .put("authorityLineageKey", lineage)
            .put("claimedLineageRevision", claim)
            .put("retryOfTurnId", JSONObject.NULL)
            .put("laneKey", "private_chat")
            .put("inputVisibilitySequence", 1L)
            .put("inputClearEpoch", 0L)
            .put("normalizedEnvelope", envelope)
            .put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(envelope))
            .put("outcome", new JSONObject()
                .put("type", "open")
                .put("route", JSONObject.NULL)
                .put("relayMessageId", JSONObject.NULL)
                .put("failure", JSONObject.NULL)
                .put("result", JSONObject.NULL)
                .put("redactedAt", JSONObject.NULL));
        return new TurnSubmission(
            base.turnId, base.characterId, base.sourceMessageId, base.kind,
            base.inputJson, base.snapshotJson, base.cloudJobId, base.createdAt,
            remoteTurnId, checkpoint.toString());
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index += 1) result.append(value);
        return result.toString();
    }

    private static String statusState(String raw) {
        try {
            return new JSONObject(raw).optString("state");
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private static BridgeConfig config(String lanUrl) {
        return new BridgeConfig(
            true, BridgeMode.LAN, lanUrl, "https://relay.example", "device_123456",
            "pairing-secret-123", "device-token-123456", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            500, 2_000, 60, 100, 1_200_000
        );
    }

    private static BridgeConfig cloudConfig() {
        return new BridgeConfig(
            true, BridgeMode.CLOUD, "http://lan.example", "https://relay.example", "device_123456",
            "pairing-secret-123", "device-token-123456", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            500, 2_000, 60, 100, 1_200_000
        );
    }

    private static LifecycleControl clearControl(
        String state, String leaseId, Long leasedAt, String relayMessageId, Long relayExpiresAt
    ) throws Exception {
        long requestedAt = 1_784_400_000_000L;
        String cursorChecksum = repeat('e', 64);
        LifecycleControlCodec.Encoded encoded = LifecycleControlCodec.encodeConversationClear(
            "yuqi", "device_123456", 1L, 7L, requestedAt, cursorChecksum);
        return new LifecycleControl(
            encoded.controlId, LifecycleControl.CLEAR_KIND, "yuqi", "device_123456",
            1L, 7L, requestedAt, encoded.semantic.toString(), encoded.semanticChecksum,
            state, leaseId, leaseId == null ? 0L : 1L, leasedAt, relayMessageId, null,
            relayExpiresAt, requestedAt
        );
    }

    private static BridgeClient receiptClient(FakeTransport transport, MutableTime time) {
        return new BridgeClient(
            config("http://lan.example"), null, transport, time, millis -> {}, null, null,
            new BridgeClient.Base64Codec() {
                @Override public byte[] decode(String value) {
                    return Base64.getDecoder().decode(value);
                }

                @Override public String encode(byte[] value) {
                    return Base64.getEncoder().encodeToString(value);
                }
            });
    }

    private static BridgeClient lifecycleCloudClient(FakeTransport transport) {
        return new BridgeClient(
            cloudConfig(), null, transport, () -> 1784400000000L,
            millis -> {}, null, null,
            new BridgeClient.Base64Codec() {
                @Override public byte[] decode(String value) {
                    return Base64.getDecoder().decode(value);
                }

                @Override public String encode(byte[] value) {
                    return Base64.getEncoder().encodeToString(value);
                }
            });
    }

    private static final class FakeTransport implements BridgeClient.Transport {
        final ArrayDeque<BridgeClient.HttpResult> responses = new ArrayDeque<>();
        final List<String> targets = new ArrayList<>();
        final List<String> nonces = new ArrayList<>();
        final List<String> bodies = new ArrayList<>();

        @Override public BridgeClient.HttpResult request(String method, String target, String body, String[][] headers) {
            targets.add(target);
            bodies.add(body);
            String nonce = "";
            for (String[] header : headers) if ("X-Yuqi-Nonce".equals(header[0])) nonce = header[1];
            nonces.add(nonce);
            return responses.removeFirst();
        }
    }

    private static final class MutableTime implements BridgeClient.Clock, BridgeClient.Sleeper {
        long now;
        MutableTime(long now) { this.now = now; }
        @Override public long now() { return now; }
        @Override public void sleep(long millis) { now += Math.max(1L, millis); }
    }
}
