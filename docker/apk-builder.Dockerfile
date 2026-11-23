# Linux image that builds the agent app's Android APK (no Windows path-length limits).
# Used by apps/agent/scripts/build-apk.sh; build once:
#   docker build -t cablenet-apk-builder -f docker/apk-builder.Dockerfile docker
FROM node:24-bookworm
ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk \
    PNPM_HOME=/pnpm CI=1 GRADLE_OPTS="-Dorg.gradle.daemon=false"
ENV PATH=$PNPM_HOME:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
 && curl -fsSL -o /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
 && unzip -q /tmp/tools.zip -d $ANDROID_HOME/cmdline-tools \
 && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
 && rm /tmp/tools.zip \
 && yes | sdkmanager --licenses > /dev/null \
 && sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.1.12297006" "cmake;3.22.1" > /dev/null
WORKDIR /src
