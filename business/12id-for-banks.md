# 12id for Banks
*Secure customer approvals inside your own banking app, on your own servers.*

## 1. What the bank gets
- **A secure connection to every customer's phone,** built into the bank's existing app. Customers install nothing new.
- **Approvals that cannot be faked.** When a customer approves something, their phone creates a digital proof. The key behind it never leaves the phone, so the proof cannot be copied, forwarded or intercepted.
- **Digital credentials in the app.** The bank can issue items such as a verified customer card. They can reveal a single fact, such as "KYC valid", without showing the full record.
- **Full control.** Everything runs on the bank's own servers. An admin console keeps a record of every action.

## 2. The gap when only the bank uses it
12id's biggest strength is letting **someone other than the bank** trust what the bank issued, without calling the bank. When the bank is the only user, that strength has nothing to act on, because the bank already knows everything about its customers.

The value then comes mainly from **customer approvals** (section 3). Bank documents and data sharing (section 5) only pay off once outside parties take part.

## 3. How the bank can use it

**3.1 Transfer confirmation**
- **What:** The amount and payee appear in the app, and the customer taps Approve.
- **Replaces:** the SMS OTP.
- **Value:** No code exists for SIM swap or an OTP scam to steal, and the customer sees exactly what they are approving.

**3.2 Approvals from other channels**
- **What:** Internet-banking transfers, cardless ATM withdrawals and branch requests are approved on the customer's phone.
- **Replaces:** the SMS OTP.
- **Value:** The customer approves everything in one trusted place.

**3.3 Extra checks for risky actions**
- **What:** A new payee, a higher limit, a new device or a large transfer asks for one more approval in the app.
- **Replaces:** an extra OTP or a branch visit.
- **Value:** Account takeovers are stopped at the moment that matters. For the riskiest actions, the bank can also require a face check (section 4).

**3.4 Web banking login by QR**
- **What:** The customer scans a QR code on the website with the bank app and approves.
- **Replaces:** the password plus OTP.
- **Value:** There is no password or code to type into a fake website.

**3.5 Call-centre caller check**
- **What:** The agent sends a check, and the caller approves it in the app.
- **Replaces:** security questions such as date of birth or mother's name.
- **Value:** Calls are shorter, and impostors who know personal details cannot get through.

**3.6 Agent-banking cash-out**
- **What:** The customer approves the cash-out on their own phone, and the agent sees only "approved".
- **Replaces:** an OTP read out to the agent.
- **Value:** The agent never holds the customer's code, which reduces agent fraud.

## 4. Optional: face check for high-value actions
A normal approval proves that **the customer's phone** approved. The PIN or fingerprint the bank app asks for protects the phone itself. Some actions need proof that **the customer in person** is there. For those, the bank can switch on 12id's optional face check.

- **How it works:** The customer takes a short selfie video in the app. The system checks that a live person is in front of the camera, not a photo, screen or mask. It then compares the face with the photo the bank already holds from KYC.
- **Decided on the server:** The result comes from the face-check service, not from the phone. A tampered app cannot skip or fake it.
- **Set by the bank:** The bank chooses which actions need a face check, how strict the match must be and how many attempts are allowed.
- **Privacy:** Photos are deleted as soon as the decision is made. Only the result and scores are kept, as an audit record.
- **Where it fits:**
  - large transfers;
  - raising limits;
  - moving the account to a new phone without a branch visit;
  - re-KYC;
  - any request where an impostor holding the customer's phone would be costly.

## 5. Future scope (needs third parties)
**Verifiable bank documents**
- **What:** Solvency certificates, balance and account confirmations, statements, salary confirmations and loan clearance letters are issued into the customer's app instead of on paper.
- **How they are used:** The customer shows the document to an embassy, employer, landlord or tender office by scanning a QR code. The checker sees the result in seconds.
- **Replaces:** printed letterhead documents, and the phone calls and emails the branch receives asking it to confirm them.
- **Value:**
  - The documents cannot be forged or edited.
  - The customer gets them instantly, without a branch visit.
  - A document can prove one fact, such as "balance above BDT 10 lakh", without revealing the balance or the full statement.
- **Needs:** whoever checks the document must also use 12id.

**KYC reuse across group companies and partners**
- **What:** The bank verifies a customer once. With the customer's consent, a subsidiary or partner, such as a brokerage, insurer or leasing company, accepts that verification instead of collecting the documents again.
- **Value:** Onboarding is faster, the customer does not repeat paperwork, and each company receives only the details it needs.
- **Needs:** the other companies must use 12id, and the regulator must allow them to rely on the bank's verification.
