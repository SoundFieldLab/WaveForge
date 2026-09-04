// JNI 桥：把 Java/Kotlin 的 startNodeWithArguments 调用转交给 node::Start。
// 实现参照 nodejs-mobile 官方 Android 接入指南（Getting started: Android native apps）。
#include <jni.h>
#include <string>
#include <cstdlib>
#include "node.h"

// node 的 libuv 要求所有参数位于连续内存中。
extern "C" jint JNICALL
Java_com_waveforge_android_MainActivity_startNodeWithArguments(
        JNIEnv *env,
        jobject /* this */,
        jobjectArray arguments) {

    // argc
    jsize argument_count = env->GetArrayLength(arguments);

    // 计算所有参数在连续内存中所需的字节数。
    int c_arguments_size = 0;
    for (int i = 0; i < argument_count ; i++) {
        c_arguments_size += strlen(env->GetStringUTFChars((jstring)env->GetObjectArrayElement(arguments, i), 0));
        c_arguments_size++; // 为 '\0' 预留
    }

    // 在连续内存中存放参数。
    char* args_buffer = (char*) calloc(c_arguments_size, sizeof(char));

    // 传给 node 的 argv。
    char* argv[argument_count];

    // 用于遍历 args_buffer 中每个参数的预期起始位置。
    char* current_args_position = args_buffer;

    // 填充 args_buffer 与 argv。
    for (int i = 0; i < argument_count ; i++) {
        const char* current_argument = env->GetStringUTFChars((jstring)env->GetObjectArrayElement(arguments, i), 0);

        // 把当前参数复制到其预期位置。
        strncpy(current_args_position, current_argument, strlen(current_argument));

        // 记录当前参数的起始位置到 argv。
        argv[i] = current_args_position;

        // 移动到下一个参数的预期位置。
        current_args_position += strlen(current_args_position) + 1;
    }

    // 用 argc 与 argv 启动 node。
    int node_result = node::Start(argument_count, argv);
    free(args_buffer);

    return jint(node_result);
}
