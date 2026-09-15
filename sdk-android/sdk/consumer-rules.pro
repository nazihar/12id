# slf4j finds its binding by class name.
-keep class org.slf4j.impl.** { *; }

# The SDK's persisted state is decoded with kotlinx.serialization; keep generated serializers.
-keepclassmembers class com.onetwoid.sdk.internal.** { *** Companion; }
-keepclasseswithmembers class com.onetwoid.sdk.internal.** { kotlinx.serialization.KSerializer serializer(...); }
