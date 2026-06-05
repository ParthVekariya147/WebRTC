# Privacy Policy & Terms of Service

> **Not legal advice.** These are drafts tailored to the app's P2P architecture. Have a lawyer review before launch, and confirm jurisdiction-specific obligations (GDPR, CCPA, HIPAA if you target healthcare).
> Replace all `[BRACKETS]` before use.

---

# Privacy Policy

**Last updated:** [DATE]
**Service:** [APP NAME] ("the Service"), operated by [COMPANY] ("we", "us").

## 1. The short version
The Service is peer-to-peer. Your video, audio, files, and chat messages travel **directly between participants** over encrypted WebRTC channels. **We never receive, store, or have access to that content.** Our server only helps participants find each other.

## 2. What we process
| Data | Why | Stored? |
|---|---|---|
| Room ID | Route the connection handshake | In memory only, deleted when room empties |
| Temporary peer ID | Identify participants during a session | In memory only, ephemeral |
| IP address (at connect time) | Establish the WebSocket signaling connection | Not persisted by us; may appear in standard infra logs |
| Connection timestamps | Operate and debug the signaling service | Short-term operational logs only |

## 3. What we do NOT collect or store
- Video or audio streams.
- Files you transfer.
- Chat message content (chat is in-memory on each device and cleared when the tab closes).
- Accounts, names, or profiles (v1 has no login).

The signaling server relays only SDP and ICE handshake messages. Once a peer connection is established, the server is no longer in the data path.

## 4. Encryption
All media is encrypted with SRTP; all data channels (chat, files) are encrypted with DTLS. This is enforced by WebRTC and cannot be disabled.

## 5. TURN relay servers
If a direct connection is blocked by your network, traffic may be relayed through a TURN server. The relay forwards **encrypted** packets and cannot read their contents. TURN providers may process IP/connection metadata to route packets. Provider(s): [TURN PROVIDER].

## 6. Third-party infrastructure
- **Signaling hosting:** [Render] — processes connection metadata only.
- **Client hosting / CDN:** [Vercel] — serves the app; standard request logs.
- **STUN/TURN:** [Google STUN / your TURN provider].

We do not sell or share personal data with advertisers. The Service contains no ads or third-party tracking.

## 7. Cookies & local storage
The app uses browser storage only for session function (e.g., temporary peer ID). No advertising or analytics cookies in v1. [Update if you add analytics.]

## 8. Data retention
We retain no user content. Operational logs containing connection metadata are kept for [N] days, then deleted.

## 9. Your rights (GDPR / CCPA)
Because we hold no persistent personal data tied to you, there is typically nothing to export or delete. For requests or questions about metadata in operational logs, contact [PRIVACY EMAIL]. EU/UK users have rights to access, rectification, erasure, and to lodge a complaint with a supervisory authority. California users have rights under the CCPA/CPRA. We do not sell personal information.

## 10. Children
The Service is not directed to children under [13/16, per jurisdiction]. We do not knowingly process their data.

## 11. Changes
We may update this policy. Material changes will be posted at [URL] with a new "Last updated" date.

## 12. Contact
[PRIVACY EMAIL] · [COMPANY ADDRESS]

---

# Terms of Service

**Last updated:** [DATE]

## 1. Acceptance
By using [APP NAME] you agree to these Terms. If you do not agree, do not use the Service.

## 2. What the Service is
A peer-to-peer real-time communication tool (video, audio, file transfer, chat) built on WebRTC. Communication occurs directly between participants; we provide a signaling server to initiate connections and do not handle or store your content.

## 3. Eligibility
You must be at least [18 / age of majority in your jurisdiction], or have consent from a parent/guardian if permitted. By using the Service you represent you meet this requirement.

## 4. Acceptable use
You agree not to use the Service to:
- transmit unlawful, infringing, harassing, or harmful content;
- violate others' privacy or intellectual property;
- distribute malware or attempt to disrupt or overload the signaling server;
- circumvent the participant limit or security controls.

We may restrict access for violations.

## 5. Recording & consent
The Service does not record sessions [confirm against your final feature set]. If you record a session by any means, **you are solely responsible** for obtaining all legally required consents from other participants under applicable law.

## 6. Peer-to-peer nature & assumption of risk
Because connections are direct between participants:
- Other participants may see your IP address as part of normal WebRTC operation.
- Connection quality depends on participants' networks and may fail on restrictive networks.
- We cannot moderate, intercept, or retrieve content exchanged between peers.
You accept these characteristics as inherent to the Service.

## 7. No warranty
The Service is provided "AS IS" and "AS AVAILABLE", without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement. We do not warrant uninterrupted or error-free operation.

## 8. Limitation of liability
To the maximum extent permitted by law, [COMPANY] is not liable for indirect, incidental, special, consequential, or punitive damages, or for any loss of data, profits, or content exchanged between peers. Our total liability shall not exceed [the amount you paid in the prior 12 months / USD 100].

## 9. Intellectual property
The Service software, branding, and content (excluding user-exchanged content) are owned by [COMPANY] and protected by law. You receive a limited, revocable, non-exclusive license to use the Service.

## 10. Termination
We may suspend or terminate access at any time for violation of these Terms or to protect the Service. You may stop using the Service at any time.

## 11. Governing law
These Terms are governed by the laws of [JURISDICTION], without regard to conflict-of-law rules. Disputes shall be resolved in the courts of [VENUE].

## 12. Changes
We may modify these Terms. Continued use after changes constitutes acceptance. Latest version at [URL].

## 13. Contact
[SUPPORT EMAIL] · [COMPANY ADDRESS]
