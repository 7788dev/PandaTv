-dontwarn javax.annotation.**
-dontwarn org.checkerframework.**
-dontwarn com.google.errorprone.**
-dontwarn com.google.j2objc.**
-dontwarn org.codehaus.mojo.animal_sniffer.**
-dontwarn org.jspecify.**
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
}
