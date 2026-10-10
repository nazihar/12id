package com.onetwoid.reference

import androidx.compose.ui.graphics.Color

/**
 * Everything that makes the app look like one organisation's app. The wallet code (Wallet.kt) and the
 * backend calls (Backend.kt) are the same for every skin; a new client is a new entry in [Skins].
 */
data class Skin(
    val id: String,
    val organisation: String,
    val tagline: String,
    val primary: Color,
    val onPrimary: Color,
    /** What the credential is called in this app. */
    val cardTitle: String,
    /** Credential attribute → the label shown on the card, in this order. Attributes not listed are not shown. */
    val attributeLabels: Map<String, String>,
    val action: ActionSkin,
)

/** The one thing the user does that needs their proof. `type` is the action's name in the backend's tenant.json. */
data class ActionSkin(
    val type: String,
    val button: String,
    val title: String,
    val fields: List<ActionField>,
    val confirm: String,
    val approved: String,
    val declined: String,
)

data class ActionField(val key: String, val label: String, val numeric: Boolean = false)

object Skins {
    val bank = Skin(
        id = "bank",
        organisation = "Acme Bank",
        tagline = "Approve with your phone, not with a code",
        primary = Color(0xFF1F3A5F),
        onPrimary = Color.White,
        cardTitle = "Verified customer",
        attributeLabels = linkedMapOf("fullName" to "Name", "memberId" to "Customer ID", "level" to "KYC level"),
        action = ActionSkin(
            type = "transfer",
            button = "Send money",
            title = "Send money",
            fields = listOf(ActionField("amount", "Amount (BDT)", numeric = true), ActionField("payee", "To")),
            confirm = "Approve transfer",
            approved = "Transfer approved",
            declined = "Transfer not approved",
        ),
    )

    val all = listOf(bank)

    /** One skin for now; a chooser in Settings can replace this later. */
    val current: Skin = bank
}
