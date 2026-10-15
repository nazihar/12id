package com.onetwoid.reference

import android.content.Context
import android.graphics.BitmapFactory
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Login
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.CreditScore
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.DragHandle
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SupportAgent
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material.icons.outlined.Widgets
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.onetwoid.sdk.BiometricStatus
import com.onetwoid.sdk.Credential
import com.onetwoid.sdk.CredentialOffer
import com.onetwoid.sdk.ProofRequest
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

/*
 * The MTB Neo skin: a copy of the login and home screens of MTB's own app, with this app's two flows in
 * it (the card is issued at the first log-in; MTB Transfer is approved with the card). Only the look is
 * here. The flows are MainViewModel's, the SDK calls Wallet.kt's, exactly as for the standard skin.
 * Colours and sizes were measured from screenshots of MTB Neo; controls that are not part of the demo
 * show a short note.
 */

private object Neo {
    val teal = Color(0xFF128E8A)
    val title = Color(0xFF2E7585)
    val ink = Color(0xFF2E2E2E)
    val wordmark = Color(0xFF323232)
    val muted = Color(0xFF6B6F76)
    val rule = Color(0xFFCCCCCC)
    val sectionRule = Color(0xFF7D8784)
    val section = Color(0xFF2D5A46)
    val icon = Color(0xFF1F4A54)
    val iconCircle = Color(0xFFF2F2F5)
    val field = Color(0xFFF8F8F8)
    val fieldBorder = Color(0xFFD0C4D4)
    val fieldDivider = Color(0xFFE0E0E0)
    val show = Color(0xFF224A51)
    val check = Color(0xFFB090D6)
    val disabled = Color(0xFFE3E3E3)
    val outline = Color(0xFFE8E8E8)
    val tileBorder = Color(0xFFE9E9E9)
    val tile = Brush.horizontalGradient(listOf(Color(0xFFF4F0F8), Color(0xFFFCF7FB)))
    val headerTop = Color(0xFF18515D)
    val headerBottom = Color(0xFF0A8A78)
    val nav = Color(0xFFE8F1F3)
    val navActive = Color(0xFF238A7A)
    val navInactive = Color(0xFF313849)
    val action = Brush.horizontalGradient(listOf(Color(0xFF089797), Color(0xFF4BB85C)))
    val cardText = Color(0xFF214B5A)
    val error = Color(0xFFC0392B)
    val errorBackground = Color(0xFFFDECEA)
}

private val Outfit = FontFamily(
    Font(R.font.outfit_regular, FontWeight.Normal),
    Font(R.font.outfit_medium, FontWeight.Medium),
    Font(R.font.outfit_semibold, FontWeight.SemiBold),
)

private fun outfit(): Typography = Typography().run {
    fun TextStyle.o() = copy(fontFamily = Outfit)
    Typography(
        displayLarge = displayLarge.o(), displayMedium = displayMedium.o(), displaySmall = displaySmall.o(),
        headlineLarge = headlineLarge.o(), headlineMedium = headlineMedium.o(), headlineSmall = headlineSmall.o(),
        titleLarge = titleLarge.o(), titleMedium = titleMedium.o(), titleSmall = titleSmall.o(),
        bodyLarge = bodyLarge.o(), bodyMedium = bodyMedium.o(), bodySmall = bodySmall.o(),
        labelLarge = labelLarge.o(), labelMedium = labelMedium.o(), labelSmall = labelSmall.o(),
    )
}

@Composable
fun MtbNeoApp(viewModel: MainViewModel, skin: Skin) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val notInDemo: () -> Unit = {
        scope.launch {
            snackbar.currentSnackbarData?.dismiss()
            snackbar.showSnackbar("Not part of this demo")
        }
    }

    MaterialTheme(colorScheme = lightColorScheme(primary = Neo.teal, onPrimary = Color.White, background = Color.White, surface = Color.White), typography = outfit()) {
        Box(Modifier.fillMaxSize().background(Color.White)) {
            when (val screen = ui.screen) {
                Screen.SignIn -> Login(ui, viewModel::signIn, notInDemo)
                is Screen.Working -> Working(screen.message)
                Screen.Photo -> PhotoOnFile(skin, ui, viewModel::submitPhoto)
                Screen.Home -> Home(skin, ui, viewModel, notInDemo)
                Screen.ActionForm -> TransferForm(skin, ui, viewModel::startAction, viewModel::backHome)
                is Screen.ActionWaiting -> TransferWaiting(skin, ui, screen, viewModel::backHome)
                is Screen.ActionDone -> TransferDone(skin, ui, screen, viewModel::backHome)
            }
            SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 80.dp))
        }

        val activity = LocalContext.current as ComponentActivity
        ui.offer?.let { OfferSheet(skin, it, ui, onAccept = { viewModel.acceptOffer(activity) }, onDecline = viewModel::declineOffer) }
        val waiting = ui.screen as? Screen.ActionWaiting
        if (waiting != null) ui.request?.let { ApprovalSheet(skin, waiting.details, it, ui, onApprove = { viewModel.approveRequest(activity) }, onDecline = viewModel::declineRequest) }
        BackHandler(enabled = ui.screen is Screen.ActionForm || ui.screen is Screen.ActionDone, onBack = viewModel::backHome)
    }
}

// ---- Log in (MTB Neo's own log-in screen) ----

@Composable
private fun Login(ui: Ui, onSignIn: (String, String) -> Unit, notInDemo: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("mtb-neo", Context.MODE_PRIVATE) }
    var userId by rememberSaveable { mutableStateOf(prefs.getString("userId", null).orEmpty()) }
    var password by rememberSaveable { mutableStateOf("") }
    var rememberMe by rememberSaveable { mutableStateOf(prefs.contains("userId")) }
    var showPassword by rememberSaveable { mutableStateOf(false) }
    val ready = !ui.busy && userId.isNotBlank() && password.isNotBlank()
    val logIn = {
        prefs.edit().apply { if (rememberMe) putString("userId", userId.trim()) else remove("userId") }.apply()
        onSignIn(userId, password)
    }

    Box(Modifier.fillMaxSize()) {
        Wave(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(230.dp).offset(y = 40.dp), alpha = 0.10f)
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(33.dp))
            Logo(Modifier.align(Alignment.CenterHorizontally))
            Spacer(Modifier.height(12.dp))
            SectionTitle("Log In", Neo.title, 20.sp, Neo.rule, FontWeight.Normal)
            Spacer(Modifier.height(14.dp))
            FieldBox {
                BoxField(userId, { userId = it }, "Enter User ID")
                HorizontalDivider(color = Neo.fieldDivider)
                BoxField(
                    password, { password = it }, "Enter Password",
                    hidden = !showPassword,
                    trailing = { Text(if (showPassword) "HIDE" else "SHOW", color = Neo.show, fontSize = 13.sp, modifier = Modifier.clickable { showPassword = !showPassword }.padding(8.dp)) },
                )
            }
            ui.error?.let { Text(it, color = Neo.error, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp)) }
            Spacer(Modifier.height(20.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(18.dp).clip(RoundedCornerShape(2.dp)).border(1.5.dp, Neo.check, RoundedCornerShape(2.dp)).clickable { rememberMe = !rememberMe }, contentAlignment = Alignment.Center) {
                    if (rememberMe) Icon(Icons.Rounded.Check, null, tint = Neo.check, modifier = Modifier.size(14.dp))
                }
                Spacer(Modifier.width(22.dp))
                Text("Remember me", fontSize = 15.5.sp, color = Neo.ink, modifier = Modifier.clickable { rememberMe = !rememberMe })
                Spacer(Modifier.weight(1f))
                Text("Forgot ID or Password?", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = Neo.ink, textDecoration = TextDecoration.Underline, modifier = Modifier.clickable(onClick = notInDemo))
            }
            Spacer(Modifier.height(18.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                ActionButton("Log In", enabled = ready, onClick = logIn, modifier = Modifier.weight(1f), busy = ui.busy)
                Spacer(Modifier.width(22.dp))
                Box(Modifier.padding(end = 7.dp).size(47.dp).clip(RoundedCornerShape(8.dp)).border(1.dp, Neo.outline, RoundedCornerShape(8.dp)).clickable(onClick = notInDemo), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Fingerprint, "Fingerprint", tint = Color.Black, modifier = Modifier.size(40.dp))
                }
            }
            Spacer(Modifier.height(44.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                OutlineButton("Register to MTB Neo", notInDemo, Modifier.weight(1f))
                OutlineButton("Open MTB Account", notInDemo, Modifier.weight(1f))
            }
            Spacer(Modifier.height(58.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                LoginTile("Explore MTB Neo", notInDemo, Modifier.weight(1f)) { Icon(Icons.Outlined.Widgets, null, tint = Color(0xFF333550), modifier = Modifier.size(22.dp)) }
                LoginTile("Speak to Me", notInDemo, Modifier.weight(1f)) {
                    Box(Modifier.size(28.dp).clip(CircleShape).border(1.dp, Neo.teal, CircleShape).background(Color(0xFFE7F1F1)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.SupportAgent, null, tint = Neo.icon, modifier = Modifier.size(18.dp))
                    }
                }
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}

/** MTB's symbol (mtb_neo_logo.webp) with the "MTB Neo™" wordmark under it. */
@Composable
private fun Logo(modifier: Modifier = Modifier, scale: Float = 1f) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Image(
            painterResource(R.drawable.mtb_neo_logo), contentDescription = "MTB Neo",
            contentScale = ContentScale.Crop,
            modifier = Modifier.width(132.dp * scale).height(68.dp * scale),
        )
        Text(
            buildAnnotatedString {
                pushStyle(SpanStyle(color = Neo.wordmark, fontWeight = FontWeight.SemiBold)); append("MTB "); pop()
                pushStyle(SpanStyle(color = Neo.teal, fontWeight = FontWeight.Medium)); append("Neo"); pop()
                pushStyle(SpanStyle(color = Color(0xFF151515), fontSize = 7.sp * scale, baselineShift = BaselineShift(0.75f))); append("TM"); pop()
            },
            fontSize = 16.5.sp * scale,
            modifier = Modifier.offset(x = 4.dp * scale, y = (-12).dp * scale),
        )
    }
}

@Composable
private fun SectionTitle(text: String, color: Color, size: TextUnit, ruleColor: Color, weight: FontWeight = FontWeight.Medium, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(text, color = color, fontSize = size, fontWeight = weight)
        Spacer(Modifier.width(14.dp))
        HorizontalDivider(Modifier.weight(1f), thickness = 0.8.dp, color = ruleColor)
    }
}

@Composable
private fun FieldBox(content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(Neo.field).border(1.dp, Neo.fieldBorder, shape), content = content)
}

/** One row of MTB's field box: the hint is the label, in the same black as the text. */
@Composable
private fun BoxField(
    value: String,
    onValue: (String) -> Unit,
    hint: String,
    hidden: Boolean = false,
    numeric: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(Modifier.fillMaxWidth().height(61.dp).padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        BasicTextField(
            value = value,
            onValueChange = onValue,
            singleLine = true,
            textStyle = TextStyle(fontFamily = Outfit, fontSize = 13.5.sp, color = Color.Black),
            cursorBrush = SolidColor(Neo.teal),
            visualTransformation = if (hidden) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(keyboardType = if (hidden) KeyboardType.Password else if (numeric) KeyboardType.Number else KeyboardType.Text),
            modifier = Modifier.weight(1f),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) Text(hint, fontSize = 13.5.sp, color = Color.Black)
                    inner()
                }
            },
        )
        trailing?.invoke()
    }
}

/** The main button: grey while it cannot be pressed, MTB's teal-to-green when it can. */
@Composable
private fun ActionButton(text: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, busy: Boolean = false) {
    val shape = RoundedCornerShape(8.dp)
    Box(
        modifier.height(46.dp).clip(shape)
            .then(if (enabled) Modifier.background(Neo.action) else Modifier.background(Neo.disabled))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp)
        else Text(text, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun OutlineButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(10.dp)
    Box(modifier.height(45.dp).clip(shape).border(1.dp, Neo.outline, shape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(text, color = Color(0xFF333333), fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

@Composable
private fun LoginTile(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: @Composable () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier.height(45.dp).clip(shape).background(Neo.tile).border(1.dp, Neo.tileBorder, shape).clickable(onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon()
        Spacer(Modifier.width(12.dp))
        Text(text, color = Color(0xFF302D31), fontSize = 11.5.sp)
    }
}

// ---- First log-in: progress, the photo on file, the card offer ----

@Composable
private fun Working(message: String) {
    Column(Modifier.fillMaxSize().statusBarsPadding().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Logo()
        Spacer(Modifier.height(48.dp))
        CircularProgressIndicator(color = Neo.teal, strokeWidth = 3.dp)
        Spacer(Modifier.height(20.dp))
        Text(message, color = Neo.ink, fontSize = 14.sp, textAlign = TextAlign.Center)
    }
}

@Composable
private fun PhotoOnFile(skin: Skin, ui: Ui, onPhoto: (ByteArray) -> Unit) {
    var problem by remember { mutableStateOf<String?>(null) }
    val takePhoto = rememberPhotoTaker(onPhoto) { problem = it }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(33.dp))
        Logo(Modifier.align(Alignment.CenterHorizontally))
        Spacer(Modifier.height(30.dp))
        SectionTitle("Your photo", Neo.title, 20.sp, Neo.rule, FontWeight.Normal)
        Spacer(Modifier.height(18.dp))
        Text("${skin.organisation} keeps a photo of each customer. Before important steps it checks that the person holding this phone is you, by comparing your face with that photo.", color = Neo.ink, fontSize = 14.sp)
        Spacer(Modifier.height(12.dp))
        Text("Take a clear photo of your face, looking at the camera.", color = Neo.ink, fontSize = 14.sp)
        (problem ?: ui.error)?.let { Text(it, color = Neo.error, fontSize = 13.sp, modifier = Modifier.padding(top = 12.dp)) }
        Spacer(Modifier.height(28.dp))
        ActionButton("Take my photo", enabled = !ui.busy, onClick = { problem = null; takePhoto() }, modifier = Modifier.fillMaxWidth(), busy = ui.busy)
    }
}

@Composable
private fun OfferSheet(skin: Skin, offer: CredentialOffer, ui: Ui, onAccept: () -> Unit, onDecline: () -> Unit) {
    val faceCheck = offer.biometric?.status == BiometricStatus.Pending
    NeoDialog {
        Icon(Icons.Outlined.VerifiedUser, null, tint = Neo.teal, modifier = Modifier.size(40.dp))
        Text("Verify this phone", color = Neo.title, fontSize = 19.sp)
        Text("${skin.organisation} adds your ${skin.cardTitle} card to this phone. With it you approve transfers on this phone, with no OTP.", color = Neo.ink, fontSize = 14.sp)
        Facts(skin.attributeLabels.mapNotNull { (name, label) -> offer.attributes[name]?.let { label to it } })
        if (faceCheck) FaceNote(skin, offer.biometric?.attemptsRemaining)
        ui.error?.let { Text(it, color = Neo.error, fontSize = 13.sp) }
        ActionButton(if (faceCheck) "Check my face" else "Add card", enabled = !ui.busy, onClick = onAccept, modifier = Modifier.fillMaxWidth(), busy = ui.busy)
        TextAction("Not now", enabled = !ui.busy, onClick = onDecline)
    }
}

@Composable
private fun FaceNote(skin: Skin, attemptsRemaining: Int?) {
    Text(
        "${skin.organisation} first checks that it is you: you look at the camera for a few seconds." + (attemptsRemaining?.let { " Attempts left: $it." } ?: ""),
        color = Neo.muted, fontSize = 12.5.sp,
    )
}

@Composable
private fun NeoDialog(content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = {}, properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false)) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(Color.White).verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}

@Composable
private fun TextAction(text: String, enabled: Boolean = true, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(8.dp)).clickable(enabled = enabled, onClick = onClick), contentAlignment = Alignment.Center) {
        Text(text, color = if (enabled) Neo.show else Neo.muted, fontSize = 14.sp, fontWeight = FontWeight.Medium)
    }
}

/** Label/value rows, as on a receipt. */
@Composable
private fun Facts(rows: List<Pair<String, String>>) {
    if (rows.isEmpty()) return
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Neo.field).border(1.dp, Neo.fieldDivider, RoundedCornerShape(12.dp)).padding(horizontal = 16.dp, vertical = 6.dp)) {
        rows.forEachIndexed { i, (label, value) ->
            if (i > 0) HorizontalDivider(color = Neo.fieldDivider)
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, color = Neo.muted, fontSize = 13.sp, modifier = Modifier.weight(1f))
                Text(value, color = Neo.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.End)
            }
        }
    }
}

// ---- Home (MTB Neo's own home screen) and Profile ----

@Composable
private fun Home(skin: Skin, ui: Ui, viewModel: MainViewModel, notInDemo: () -> Unit) {
    var tab by rememberSaveable { mutableStateOf(0) }
    Box(Modifier.fillMaxSize()) {
        if (tab == 0) HomeTab(skin, ui, viewModel, notInDemo) else ProfileTab(skin, ui, viewModel)
        BottomBar(tab, onTab = { tab = it }, notInDemo, Modifier.align(Alignment.BottomCenter))
    }
}

@Composable
private fun HomeTab(skin: Skin, ui: Ui, viewModel: MainViewModel, notInDemo: () -> Unit) {
    val transfer = { if (ui.card != null) viewModel.openActionForm() else viewModel.setUp() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        HomeHeader(ui, onTransfer = transfer, onSignOut = viewModel::signOut, notInDemo)
        Column(Modifier.padding(horizontal = 16.dp)) {
            ui.error?.let { Spacer(Modifier.height(16.dp)); ErrorNote(it) }
            if (ui.card == null) {
                Spacer(Modifier.height(16.dp))
                VerifyBanner(skin, ui.busy, viewModel::setUp)
            }
            Spacer(Modifier.height(26.dp))
            SectionTitle("Accounts", Neo.section, 13.sp, Neo.sectionRule)
            Spacer(Modifier.height(30.dp))
            val items = listOf(
                Triple("Accounts", Icons.Outlined.AccountCircle, notInDemo),
                Triple("MTB Transfer", Icons.Outlined.AccountBalance, transfer),
                Triple("Other Bank\nTransfer", Icons.Outlined.AccountBalance, notInDemo),
                Triple("MFS Transfer", Icons.Outlined.AccountBalanceWallet, notInDemo),
                Triple("Transfer History", Icons.AutoMirrored.Outlined.ReceiptLong, notInDemo),
                Triple("Statement", Icons.Outlined.Description, notInDemo),
            )
            items.chunked(3).forEach { row ->
                Row(Modifier.fillMaxWidth().height(111.dp)) {
                    row.forEach { (label, icon, onClick) -> GridItem(label, icon, onClick, Modifier.weight(1f)) }
                }
            }
        }
        Spacer(Modifier.height(4.dp))
        AccountCard(ui.user, notInDemo, Modifier.padding(horizontal = 8.dp))
        Spacer(Modifier.height(36.dp))
        SectionTitle("Cards", Neo.section, 13.sp, Neo.sectionRule, modifier = Modifier.padding(horizontal = 16.dp))
        Spacer(Modifier.height(36.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            repeat(3) { Box(Modifier.size(48.dp).clip(CircleShape).background(Color(0xFFF6F1F5))) }
        }
        Spacer(Modifier.navigationBarsPadding().height(120.dp))
    }
}

/** The teal header with MTB's colour wave, the customer, and the three quick actions. */
@Composable
private fun HomeHeader(ui: Ui, onTransfer: () -> Unit, onSignOut: () -> Unit, notInDemo: () -> Unit) {
    val shape = RoundedCornerShape(bottomStart = 14.dp, bottomEnd = 14.dp)
    Box(Modifier.fillMaxWidth().clip(shape).background(Brush.verticalGradient(listOf(Neo.headerTop, Neo.headerBottom)))) {
        Wave(Modifier.matchParentSize(), alpha = 1f)
        Column(Modifier.statusBarsPadding().padding(top = 23.dp, bottom = 26.dp)) {
            Row(Modifier.padding(start = 16.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(ui.user?.name)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text("Welcome to MTB Neo", color = Color.White.copy(alpha = 0.62f), fontSize = 13.sp)
                    Text(ui.user?.name.orEmpty(), color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                HeaderIcon(Icons.Outlined.Search, "Search", notInDemo)
                Spacer(Modifier.width(6.dp))
                HeaderIcon(Icons.AutoMirrored.Outlined.Login, "Log out", onSignOut)
            }
            Spacer(Modifier.height(42.dp))
            Row(Modifier.fillMaxWidth()) {
                QuickAction("MTB Transfer", Icons.Outlined.AccountBalance, onTransfer, Modifier.weight(1f))
                QuickAction("MFS Transfer", Icons.Outlined.AccountBalanceWallet, notInDemo, Modifier.weight(1f))
                QuickAction("Card Payment", Icons.Outlined.CreditScore, notInDemo, Modifier.weight(1f))
            }
        }
    }
}

/** The customer's photo on file (Photo.keep), or their initials. */
@Composable
private fun Avatar(name: String?, size: Dp = 48.dp) {
    val context = LocalContext.current
    val photo = remember(name) { Photo.kept(context)?.let { file -> runCatching { BitmapFactory.decodeFile(file.path)?.asImageBitmap() }.getOrNull() } }
    Box(Modifier.size(size).clip(CircleShape).border(1.5.dp, Color.White, CircleShape).background(Color(0xFF9E9E9E)), contentAlignment = Alignment.Center) {
        if (photo != null) Image(photo, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else Text(initials(name), color = Color.White, fontSize = (size.value * 0.36f).sp, fontWeight = FontWeight.Medium)
    }
}

private fun initials(name: String?): String =
    name.orEmpty().split(' ').filter { it.isNotBlank() }.take(2).joinToString("") { it.first().uppercase() }

@Composable
private fun HeaderIcon(icon: ImageVector, description: String, onClick: () -> Unit) {
    Box(Modifier.size(42.dp).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, description, tint = Color.White, modifier = Modifier.size(25.dp))
    }
}

@Composable
private fun QuickAction(label: String, icon: ImageVector, onClick: () -> Unit, modifier: Modifier) {
    Column(modifier.clickable(onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(48.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.22f)).border(1.dp, Color.White.copy(alpha = 0.10f), CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = Color.White, modifier = Modifier.size(26.dp))
        }
        Spacer(Modifier.height(2.dp))
        Text(label, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

@Composable
private fun GridItem(label: String, icon: ImageVector, onClick: () -> Unit, modifier: Modifier) {
    Column(modifier.fillMaxHeight().clickable(onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(48.dp).clip(CircleShape).background(Neo.iconCircle), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = Neo.icon, modifier = Modifier.size(28.dp))
        }
        Spacer(Modifier.height(4.dp))
        Text(label, color = Color(0xFF2F2F2F), fontSize = 12.sp, textAlign = TextAlign.Center, lineHeight = 17.sp)
    }
}

/** The account card. Its number is the customer's member ID, written the way MTB writes account numbers. */
@Composable
private fun AccountCard(user: Backend.User?, notInDemo: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(18.dp)
    Box(
        modifier.fillMaxWidth().height(180.dp).clip(shape)
            .background(Brush.linearGradient(listOf(Color(0xFFD8AED5), Color(0xFFB57FAB), Color(0xFF8E4E84), Color(0xFF61415E)), start = Offset.Zero, end = Offset(Float.POSITIVE_INFINITY, 0f))),
    ) {
        Canvas(Modifier.matchParentSize()) { flower(Offset(size.width * 0.86f, size.height * 0.78f), size.height * 0.62f) }
        Column(Modifier.padding(start = 16.dp, top = 18.dp)) {
            Text("MTB  REGULARSAVINGSSTAFF", color = Neo.cardText, fontSize = 16.5.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(10.dp))
            Text(accountNumber(user?.memberId), color = Neo.cardText, fontSize = 14.sp, letterSpacing = 1.sp)
            Spacer(Modifier.height(20.dp))
            Box(Modifier.height(34.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.25f)).clickable(onClick = notInDemo).padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
                Text("View balance", color = Color(0xFF264757), fontSize = 13.5.sp, fontWeight = FontWeight.Medium)
            }
        }
        Row(Modifier.align(Alignment.BottomCenter).padding(bottom = 15.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            repeat(5) { i -> Box(Modifier.size(11.dp).clip(CircleShape).background(if (i == 0) Color(0xFF0F0A0E) else Color(0xFF542D4F))) }
        }
    }
}

/** "1301 0000 4821 7733": a fixed branch and product prefix, then the 8-digit member ID. */
private fun accountNumber(memberId: String?): String {
    val id = memberId.orEmpty().padStart(8, '0')
    return "1301 0000 ${id.take(4)} ${id.drop(4)}"
}

/** A simple stand-in for the flower on MTB's card art: soft petals around a dark centre. */
private fun DrawScope.flower(center: Offset, radius: Float) {
    val petal = Color(0xFFF0B6E2).copy(alpha = 0.33f)
    repeat(12) { i ->
        rotate(degrees = i * 30f + 8f, pivot = center) {
            drawOval(petal, topLeft = Offset(center.x - radius * 0.13f, center.y - radius), size = Size(radius * 0.26f, radius * 0.82f))
        }
    }
    drawCircle(Color(0xFF4A2445).copy(alpha = 0.55f), radius * 0.22f, center)
}

@Composable
private fun VerifyBanner(skin: Skin, busy: Boolean, onVerify: () -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0xFFEAF5F3)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("This phone is not verified yet", color = Neo.section, fontSize = 14.sp, fontWeight = FontWeight.Medium)
        Text("Get your ${skin.cardTitle} card to approve transfers on this phone.", color = Neo.ink, fontSize = 13.sp)
        ActionButton("Verify this phone", enabled = !busy, onClick = onVerify, modifier = Modifier.fillMaxWidth(), busy = busy)
    }
}

@Composable
private fun ErrorNote(message: String) {
    Text(message, color = Neo.error, fontSize = 13.sp, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Neo.errorBackground).padding(12.dp))
}

/** MTB's bottom bar: four tabs around the QR button, which sits in a notch. Only Home and Profile are part of the demo. */
@Composable
private fun BottomBar(tab: Int, onTab: (Int) -> Unit, notInDemo: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(top = 27.dp).fillMaxWidth().clip(NotchedTop(35.dp, 18.dp)).background(Neo.nav).navigationBarsPadding().height(64.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NavItem("Home", Icons.Outlined.Home, tab == 0, { onTab(0) })
            NavItem("Services", Icons.Outlined.DragHandle, false, notInDemo)
            Spacer(Modifier.weight(1f))
            NavItem("Explore MTB", Icons.Outlined.Widgets, false, notInDemo)
            NavItem("Profile", Icons.Outlined.AccountCircle, tab == 1, { onTab(1) })
        }
        Box(
            Modifier.align(Alignment.TopCenter).size(54.dp).shadow(6.dp, CircleShape).clip(CircleShape).background(Neo.action).clickable(onClick = notInDemo),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.QrCodeScanner, "Scan QR", tint = Color.White, modifier = Modifier.size(30.dp))
        }
    }
}

@Composable
private fun RowScope.NavItem(label: String, icon: ImageVector, selected: Boolean, onClick: () -> Unit) {
    val color = if (selected) Neo.navActive else Neo.navInactive
    Column(Modifier.weight(1f).fillMaxHeight().clickable(onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Icon(icon, null, tint = color, modifier = Modifier.size(26.dp))
        Spacer(Modifier.height(4.dp))
        Text(label, color = color, fontSize = 13.sp, maxLines = 1, softWrap = false, fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal)
    }
}

/** A rectangle with rounded top corners and a round notch in the middle of its top edge. */
private class NotchedTop(private val notch: Dp, private val corner: Dp) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val r = with(density) { notch.toPx() }
        val c = with(density) { corner.toPx() }
        val bar = Path().apply { addRoundRect(RoundRect(Rect(Offset.Zero, size), topLeft = CornerRadius(c), topRight = CornerRadius(c))) }
        val cut = Path().apply { addOval(Rect(Offset(size.width / 2, 0f), r)) }
        return Outline.Generic(Path.combine(PathOperation.Difference, bar, cut))
    }
}

@Composable
private fun ProfileTab(skin: Skin, ui: Ui, viewModel: MainViewModel) {
    var confirmReset by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(24.dp))
        SectionTitle("Profile", Neo.title, 20.sp, Neo.rule, FontWeight.Normal)
        Spacer(Modifier.height(20.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.clip(CircleShape).background(Neo.teal).padding(2.dp)) { Avatar(ui.user?.name, 64.dp) }
            Spacer(Modifier.width(16.dp))
            Column {
                Text(ui.user?.name.orEmpty(), color = Neo.ink, fontSize = 17.sp, fontWeight = FontWeight.Medium)
                Text(accountNumber(ui.user?.memberId), color = Neo.muted, fontSize = 13.sp)
            }
        }
        Spacer(Modifier.height(28.dp))
        SectionTitle("This phone", Neo.section, 13.sp, Neo.sectionRule)
        Spacer(Modifier.height(16.dp))
        val card = ui.card
        if (card != null) VerifiedCard(skin, card) else VerifyBanner(skin, ui.busy, viewModel::setUp)
        Spacer(Modifier.height(24.dp))
        ActionButton("Log out", enabled = true, onClick = viewModel::signOut, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        TextAction("Reset this app", onClick = { confirmReset = true })
        Spacer(Modifier.navigationBarsPadding().height(120.dp))
    }

    if (confirmReset) {
        NeoDialog {
            Text("Reset this app?", color = Neo.title, fontSize = 19.sp)
            Text("Your card is deleted from this phone and you are logged out. ${skin.organisation} gives you a new card when you log in again.", color = Neo.ink, fontSize = 14.sp)
            ActionButton("Reset", enabled = true, onClick = { confirmReset = false; viewModel.reset() }, modifier = Modifier.fillMaxWidth())
            TextAction("Keep", onClick = { confirmReset = false })
        }
    }
}

/** The 12iD card in the wallet: what MTB issued to this phone. */
@Composable
private fun VerifiedCard(skin: Skin, card: Credential) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Brush.linearGradient(listOf(Neo.headerTop, Neo.headerBottom))).padding(18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.VerifiedUser, null, tint = Color.White, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(8.dp))
            Text(skin.cardTitle, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium)
        }
        skin.attributeLabels.forEach { (name, label) -> card.attributes[name]?.let { Text("$label: $it", color = Color.White.copy(alpha = 0.9f), fontSize = 13.sp) } }
        card.expiresAtEpochSeconds?.let { Text(if (card.isExpired()) "Expired" else "Valid until ${formatDate(it)}", color = Color.White.copy(alpha = 0.7f), fontSize = 12.sp) }
    }
}

// ---- MTB Transfer ----

/** The short teal header of the inner screens, with a back arrow. */
@Composable
private fun InnerHeader(title: String, onBack: (() -> Unit)?) {
    val shape = RoundedCornerShape(bottomStart = 14.dp, bottomEnd = 14.dp)
    Box(Modifier.fillMaxWidth().clip(shape).background(Brush.verticalGradient(listOf(Neo.headerTop, Neo.headerBottom)))) {
        Wave(Modifier.matchParentSize(), alpha = 0.55f)
        Row(Modifier.statusBarsPadding().padding(horizontal = 8.dp).height(64.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) HeaderIcon(Icons.AutoMirrored.Outlined.ArrowBack, "Back", onBack) else Spacer(Modifier.width(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(title, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun InnerScreen(title: String, onBack: (() -> Unit)?, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize()) {
        InnerHeader(title, onBack)
        Column(
            Modifier.fillMaxSize().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            content = content,
        )
    }
}

@Composable
private fun TransferForm(skin: Skin, ui: Ui, onStart: (Map<String, String>) -> Unit, onBack: () -> Unit) {
    val values = remember { mutableStateMapOf<String, String>() }
    val ready = !ui.busy && skin.action.fields.all { !values[it.key].isNullOrBlank() }
    InnerScreen(skin.action.title, onBack) {
        Text("From account", color = Neo.muted, fontSize = 13.sp)
        FromAccount(ui.user)
        Text("Transfer to", color = Neo.muted, fontSize = 13.sp)
        FieldBox {
            skin.action.fields.forEachIndexed { i, field ->
                if (i > 0) HorizontalDivider(color = Neo.fieldDivider)
                BoxField(values[field.key].orEmpty(), { values[field.key] = it }, field.label, numeric = field.numeric)
            }
        }
        ui.error?.let { ErrorNote(it) }
        Spacer(Modifier.height(8.dp))
        ActionButton("Next", enabled = ready, onClick = { onStart(values.toMap()) }, modifier = Modifier.fillMaxWidth(), busy = ui.busy)
    }
}

@Composable
private fun FromAccount(user: Backend.User?) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
            .background(Brush.linearGradient(listOf(Color(0xFFD8AED5), Color(0xFF8E4E84)), start = Offset.Zero, end = Offset(Float.POSITIVE_INFINITY, 0f)))
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column {
            Text("MTB  REGULARSAVINGSSTAFF", color = Neo.cardText, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Text(accountNumber(user?.memberId), color = Neo.cardText, fontSize = 13.sp, letterSpacing = 1.sp)
        }
    }
}

/** The action's details with the skin's labels; the amount is written as Taka. */
private fun detailRows(skin: Skin, details: Map<String, String>): List<Pair<String, String>> =
    skin.action.fields.mapNotNull { field -> details[field.key]?.let { field.label.removeSuffix(" (BDT)") to if (field.key == "amount") taka(it) else it } }

private fun taka(amount: String): String =
    amount.toLongOrNull()?.let { "BDT " + NumberFormat.getIntegerInstance(Locale.forLanguageTag("en-IN")).format(it) } ?: amount

@Composable
private fun TransferWaiting(skin: Skin, ui: Ui, screen: Screen.ActionWaiting, onCancel: () -> Unit) {
    InnerScreen(skin.action.title, null) {
        Facts(detailRows(skin, screen.details))
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(24.dp), color = Neo.teal, strokeWidth = 2.5.dp)
            Spacer(Modifier.width(12.dp))
            Text(screen.message, color = Neo.ink, fontSize = 14.sp)
        }
        ui.error?.let { ErrorNote(it) }
        TextAction("Cancel", onClick = onCancel)
    }
}

@Composable
private fun ApprovalSheet(skin: Skin, details: Map<String, String>, request: ProofRequest, ui: Ui, onApprove: () -> Unit, onDecline: () -> Unit) {
    val faceCheck = request.biometric?.status == BiometricStatus.Pending
    val shared = request.shared(skin)
    val proven = request.proven(skin)
    NeoDialog {
        Icon(Icons.Outlined.VerifiedUser, null, tint = Neo.teal, modifier = Modifier.size(40.dp))
        Text(skin.action.confirm, color = Neo.title, fontSize = 19.sp)
        Facts(detailRows(skin, details))
        if (shared.isNotEmpty()) Text("${skin.organisation} will see: ${shared.joinToString()}.", color = Neo.ink, fontSize = 13.sp)
        if (proven.isNotEmpty()) Text("Proven without being shown: ${proven.joinToString()}.", color = Neo.ink, fontSize = 13.sp)
        if (faceCheck) FaceNote(skin, request.biometric?.attemptsRemaining)
        ui.error?.let { Text(it, color = Neo.error, fontSize = 13.sp) }
        ActionButton(if (faceCheck) "Check my face and approve" else "Approve", enabled = !ui.busy, onClick = onApprove, modifier = Modifier.fillMaxWidth(), busy = ui.busy)
        TextAction("Decline", enabled = !ui.busy, onClick = onDecline)
    }
}

@Composable
private fun TransferDone(skin: Skin, ui: Ui, screen: Screen.ActionDone, onDone: () -> Unit) {
    InnerScreen(skin.action.title, onDone) {
        Spacer(Modifier.height(12.dp))
        Box(
            Modifier.align(Alignment.CenterHorizontally).size(76.dp).clip(CircleShape)
                .then(if (screen.approved) Modifier.background(Neo.action) else Modifier.background(Color(0xFFE57373))),
            contentAlignment = Alignment.Center,
        ) {
            Icon(if (screen.approved) Icons.Rounded.Check else Icons.Rounded.Close, null, tint = Color.White, modifier = Modifier.size(44.dp))
        }
        Text(
            if (screen.approved) skin.action.approved else skin.action.declined,
            color = if (screen.approved) Neo.section else Neo.error, fontSize = 19.sp, fontWeight = FontWeight.Medium,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
        )
        Facts(detailRows(skin, screen.details))
        if (screen.approved && screen.shared.isNotEmpty()) {
            Text("${skin.organisation} received:", color = Neo.muted, fontSize = 13.sp)
            Facts(screen.shared.map { (name, value) -> (skin.attributeLabels[name] ?: name) to value })
        }
        ui.error?.let { ErrorNote(it) }
        Spacer(Modifier.height(8.dp))
        ActionButton("Done", enabled = true, onClick = onDone, modifier = Modifier.fillMaxWidth())
    }
}

// ---- MTB's colour wave ----

/**
 * The soft ribbon of MTB's brand art: red into orange, a dip, up through yellow and green, a loop in
 * blue-grey, down into magenta, and a magenta glow at the right edge. Blurred where Android can (12+).
 */
@Composable
private fun Wave(modifier: Modifier, alpha: Float) {
    val blur = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Modifier.blur(16.dp) else Modifier
    Canvas(modifier.then(blur)) {
        val w = size.width
        val h = size.height
        fun p(x: Float, y: Float) = Offset(x * w, y * h)
        val ribbon = Path().apply {
            p(-0.08f, 0.14f).let { moveTo(it.x, it.y) }
            fun c(x1: Float, y1: Float, x2: Float, y2: Float, x3: Float, y3: Float) {
                val a = p(x1, y1); val b = p(x2, y2); val e = p(x3, y3)
                cubicTo(a.x, a.y, b.x, b.y, e.x, e.y)
            }
            c(0.04f, 0.42f, 0.16f, 0.80f, 0.31f, 0.79f)
            c(0.45f, 0.78f, 0.52f, 0.46f, 0.60f, 0.42f)
            c(0.68f, 0.38f, 0.70f, 0.62f, 0.66f, 0.72f)
            c(0.64f, 0.77f, 0.66f, 0.50f, 0.77f, 0.49f)
            c(0.84f, 0.52f, 0.86f, 0.70f, 0.92f, 0.78f)
            c(0.96f, 0.84f, 1.00f, 0.80f, 1.08f, 0.70f)
        }
        val colours = Brush.horizontalGradient(
            0.00f to Color(0xFFE8304F), 0.22f to Color(0xFFE2604A), 0.36f to Color(0xFFD98C4C), 0.50f to Color(0xFFC9B24F),
            0.60f to Color(0xFF8DC152), 0.66f to Color(0xFF5DBE6A), 0.73f to Color(0xFF7AA6AE), 0.83f to Color(0xFF8C7FB8),
            0.92f to Color(0xFFA7369A), 1.00f to Color(0xFFB5228A),
            startX = 0f, endX = w,
        )
        drawPath(ribbon, colours, alpha = alpha, style = Stroke(width = w * 0.115f, cap = StrokeCap.Round))
        drawOval(Color(0xFFB0247F), topLeft = p(0.90f, 0.20f), size = Size(w * 0.24f, h * 0.70f), alpha = alpha)
    }
}
